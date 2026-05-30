import { Hono } from 'hono';
import type { R2Bucket } from '@cloudflare/workers-types';
import { ensureSchema, ensureDefaultUser, getUserByToken, getUserByApiKey, countTodayUploads } from './db';
import authRoutes from './routes/auth';
import uploadRoutes from './routes/upload';
import imageRoutes from './routes/images';
import adminRoutes from './routes/admin';
import backupRoutes from './routes/backup';
import { json, getTodayRange } from './utils';
import { getWatermarkConfig } from './db';
import { processImage } from './image-processor';
import type { Env, AuthUser } from './types';

const app = new Hono<{ Bindings: Env; Variables: { user: AuthUser | null } }>();

// 首次访问自动建表 + 创建默认管理员
let initialized = false;
app.use('*', async (c, next) => {
  if (!initialized) {
    await ensureSchema(c.env.DB);
    await ensureDefaultUser(c.env.DB);
    initialized = true;
  }
  await next();
});

// GET /api/user/status（可选认证）
app.get('/api/user/status', async (c) => {
  const authHeader = c.req.header('Authorization');
  const apiKey = c.req.header('X-API-Key') || c.req.header('x-api-key');
  const db = c.env.DB;
  let user: AuthUser | null = null;

  if (authHeader?.startsWith('Bearer ')) {
    const u = await getUserByToken(db, authHeader.slice(7));
    if (u) user = { id: u.id, username: u.username, level: u.level, apiKey: u.apiKey, sessionVersion: u.sessionVersion };
  } else if (apiKey) {
    const u = await getUserByApiKey(db, apiKey);
    if (u) user = { id: u.id, username: u.username, level: u.level, apiKey: u.apiKey, sessionVersion: u.sessionVersion };
  }

  if (!user) return json({ authenticated: false });
  const { start, end } = getTodayRange();
  const [todayUploads, totalImages] = await Promise.all([
    countTodayUploads(db, user.id, start, end),
    db.prepare('SELECT COUNT(*) as count FROM images WHERE userId = ?').bind(user.id).first<{ count: number }>(),
  ]);
  return json({ authenticated: true, id: user.id, username: user.username, level: user.level, dailyUploads: todayUploads, totalImages: totalImages?.count ?? 0, dailyUploadLimit: 200, apiKey: user.apiKey });
});

// API 路由
app.route('/api', authRoutes);
app.route('/api', uploadRoutes);
app.route('/api', imageRoutes);
app.route('/api', adminRoutes);
app.route('/api', backupRoutes);

// /uploads/* 从 R2 代理 + 图片实时处理
app.get('/uploads/*', async (c) => {
  const bucket = c.env.IMAGES as R2Bucket;
  const key = c.req.path.replace(/^\/uploads\//, '');

  // 拒绝访问系统文件
  if (key.startsWith('_system/')) return c.notFound();

  const q = c.req.query();

  // 无参数 → 原图直出（快速路径）
  if (!q.w && !q.h && !q.f && !q.wm) {
    const object = await bucket.get(key);
    if (!object) return c.notFound();
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(object.body, { headers });
  }

  // 有参数 → Photon 处理
  const opts = {
    width: q.w ? Math.min(4000, Math.max(1, parseInt(q.w) || 0)) : undefined,
    height: q.h ? Math.min(4000, Math.max(1, parseInt(q.h) || 0)) : undefined,
    format: (['webp', 'jpeg', 'png'].includes(q.f) ? q.f : undefined) as 'webp' | 'jpeg' | 'png' | undefined,
    quality: q.q ? Math.min(100, Math.max(1, parseInt(q.q) || 85)) : undefined,
    watermark: q.wm === '1',
  };

  const wmConfig = await getWatermarkConfig(c.env.DB);
  const result = await processImage(bucket, key, opts, wmConfig);
  if (!result) return c.notFound();

  const headers = new Headers();
  headers.set('Content-Type', result.contentType);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(result.body, { headers });
});

export default app;
