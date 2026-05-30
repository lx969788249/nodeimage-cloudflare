import { Hono } from 'hono';
import type { R2Bucket } from '@cloudflare/workers-types';
import { authMiddleware, requireAdmin } from '../auth';
import { getBackupConfig } from '../db';
import { json, errorJson } from '../utils';
import { readSqlite } from '../sqlite-reader';
import { TarGzReader } from '../tar';
import type { AuthUser, Env } from '../types';

const backupRoutes = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();

// GET /api/backup — export DB as JSON download
backupRoutes.get('/backup', authMiddleware, requireAdmin, async (c) => {
  const db = c.env.DB;
  const users = await db.prepare('SELECT * FROM users').all();
  const images = await db.prepare('SELECT * FROM images').all();
  const settings = await db.prepare('SELECT * FROM settings').all();

  const dbDump = JSON.stringify({ users: users.results, images: images.results, settings: settings.results, exportedAt: new Date().toISOString() }, null, 2);
  return new Response(dbDump, {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="nodeimage-backup-${Date.now()}.json"` },
  });
});

// POST /api/backup/restore — 支持 JSON 和旧版 tar.gz 备份
backupRoutes.post('/backup/restore', authMiddleware, requireAdmin, async (c) => {
  const db = c.env.DB;
  const formData = await c.req.formData().catch(() => null);
  if (!formData) return errorJson('无效的请求数据');

  const file = formData.get('backup');
  if (!file || typeof file === 'string') return errorJson('缺少备份文件');

  const fileObj = file as unknown as { name?: string; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> };

  try {
    let data: { users: Record<string, unknown>[]; images: Record<string, unknown>[]; settings: Record<string, unknown>[] };

    const fname = (fileObj.name || '').toLowerCase();

    if (fname.endsWith('.tar.gz') || fname.endsWith('.tgz')) {
      // 旧版 tar.gz 备份 → 单次遍历提取 db.sqlite + 收集 uploads
      const tarGzBuf = new Uint8Array(await fileObj.arrayBuffer());
      const reader = new TarGzReader();
      await reader.load(tarGzBuf);

      const { sqliteBuf, uploadEntries } = reader.extractAll();
      if (!sqliteBuf) return errorJson('备份中未找到 data/db.sqlite');

      const raw = readSqlite(sqliteBuf);
      data = {
        users: raw.users,
        images: raw.images.map(({ thumbName, ...rest }: Record<string, unknown>) => rest),
        settings: raw.settings,
      };

      // 上传图片到 R2（批量，后台执行）
      const bucket = c.env.IMAGES as R2Bucket;
      c.executionCtx.waitUntil((async () => {
        let count = 0;
        const BATCH = 20; // Workers 可承载更高并发
        for (let i = 0; i < uploadEntries.length; i += BATCH) {
          const end = Math.min(i + BATCH, uploadEntries.length);
          const promises: Promise<void>[] = [];
          for (let j = i; j < end; j++) {
            const { key, data } = uploadEntries[j];
            promises.push(bucket.put(key, data).then(() => { count++; }).catch(() => {}));
          }
          await Promise.all(promises);
        }
        console.log(`Migration: uploaded ${count}/${uploadEntries.length} files to R2`);
      })());

      return json({ message: `数据库已恢复，${uploadEntries.length} 个图片文件正在上传到 R2` });
    } else {
      // JSON 备份
      const text = await fileObj.text();
      data = JSON.parse(text);
    }

    if (!data.users || !data.images || !data.settings) return errorJson('无效的备份文件格式');

    // 使用 D1 batch API 批量写入（性能远优于逐条 INSERT）
    const statements: { sql: string; params: unknown[] }[] = [];

    statements.push({ sql: 'DELETE FROM users', params: [] });
    for (const u of data.users) {
      statements.push({
        sql: 'INSERT INTO users (id, username, passwordHash, apiKey, token, level, sessionVersion, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        params: [u.id, u.username, (u.passwordHash as string) ?? null, (u.apiKey as string) ?? '', (u.token as string) ?? null, (u.level as number) ?? 1, (u.sessionVersion as number) ?? 1, (u.createdAt as number) ?? Date.now()],
      });
    }
    statements.push({ sql: 'DELETE FROM images', params: [] });
    for (const img of data.images) {
      statements.push({
        sql: 'INSERT INTO images (id, userId, filename, mime, size, width, height, createdAt, autoDelete, deleteAfterDays) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        params: [img.id, img.userId, img.filename, (img.mime as string) || '', (img.size as number) || 0, (img.width as number) ?? null, (img.height as number) ?? null, (img.createdAt as number) ?? Date.now(), (img.autoDelete as number) ?? 0, (img.deleteAfterDays as number) ?? null],
      });
    }
    statements.push({ sql: 'DELETE FROM settings', params: [] });
    for (const s of data.settings) {
      statements.push({
        sql: 'INSERT INTO settings (key, value) VALUES (?, ?)',
        params: [s.key as string, s.value as string],
      });
    }

    await db.batch(statements.map(st => db.prepare(st.sql).bind(...st.params)));
    return json({ message: '备份已恢复' });
  } catch (err: unknown) {
    return errorJson('恢复失败: ' + (err instanceof Error ? err.message : '未知错误'), 500);
  }
});

// GET /api/backup/status
backupRoutes.get('/backup/status', authMiddleware, requireAdmin, async (c) => {
  const config = await getBackupConfig(c.env.DB);
  return json({
    s3: { configured: !!(config.s3Endpoint && config.s3Bucket && config.s3AccessKey && config.s3SecretKey), endpoint: config.s3Endpoint || null, bucket: config.s3Bucket || null },
    webhook: { configured: !!config.webhookUrl, url: config.webhookUrl || null },
    intervalHours: config.intervalHours, keepCount: config.keepCount,
  });
});

export default backupRoutes;
