import { Hono } from 'hono';
import type { R2Bucket } from '@cloudflare/workers-types';
import { authMiddleware } from '../auth';
import { createImage, countTodayUploads, getCompressionConfig } from '../db';
import { convertToJpeg } from '../image-processor';
import { nanoid, getTodayRange, getYearMonth, getBaseUrl, json, errorJson } from '../utils';
import type { AuthUser, Env } from '../types';
import type { ImageRecord } from '../db';

const uploadRoutes = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();

const DAILY_UPLOAD_LIMIT = 200;
const MAX_FILE_SIZE = 100 * 1024 * 1024;

const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/avif',
  'image/heic', 'image/heif',
]);

// 不需要转 JPEG 的格式 (GIF 保留动画, AVIF 本身已现代, HEIC 服务器无法解码)
const SKIP_JPEG_CONVERT = new Set(['image/gif', 'image/avif', 'image/heic', 'image/heif']);

uploadRoutes.post('/upload', authMiddleware, async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const bucket = c.env.IMAGES as R2Bucket;

  const formData = await c.req.formData().catch(() => null);
  if (!formData) return errorJson('无效的请求数据');

  const file = formData.get('image');
  if (!file || typeof file === 'string') return errorJson('缺少图片文件');

  const fileObj = file as unknown as { type: string; size: number; name: string; arrayBuffer(): Promise<ArrayBuffer> };
  if (!ALLOWED_MIME.has(fileObj.type)) return errorJson('不支持的文件类型');
  if (fileObj.size > MAX_FILE_SIZE) return errorJson('文件大小超过限制 (最大 100MB)', 413);

  const { start, end } = getTodayRange();
  if (await countTodayUploads(db, user.id, start, end) >= DAILY_UPLOAD_LIMIT) {
    return errorJson('已达到今日上传上限', 429);
  }

  const autoDelete = formData.get('autoDelete') === 'true';
  const deleteDays = autoDelete ? Math.min(365, Math.max(1, Number(formData.get('deleteDays')) || 30)) : null;

  const { year, month } = getYearMonth();
  const id = nanoid();
  const inputBuffer = new Uint8Array(await fileObj.arrayBuffer());

  // 上传时用 SIP 转 JPEG — 流式处理，任意大小图片都行
  let finalBuffer: Uint8Array = inputBuffer;
  let finalMime = fileObj.type;
  let finalExt: string;
  let finalSize = fileObj.size;
  let converted = false;

  if (!SKIP_JPEG_CONVERT.has(fileObj.type)) {
    const compConfig = await getCompressionConfig(db);
    const result = await convertToJpeg(inputBuffer, compConfig.quality);
    if (result) {
      finalBuffer = result.data;
      finalMime = 'image/jpeg';
      finalExt = 'jpg';
      finalSize = result.data.length;
      converted = true;
    } else {
      // 转换失败 → 退回原格式
      const dotIdx = fileObj.name.lastIndexOf('.');
      finalExt = dotIdx > 0 ? fileObj.name.slice(dotIdx + 1).toLowerCase() || 'png' : 'png';
    }
  } else {
    const dotIdx = fileObj.name.lastIndexOf('.');
    finalExt = dotIdx > 0 ? fileObj.name.slice(dotIdx + 1).toLowerCase() || 'png' : 'png';
  }

  const filename = `${year}/${month}/${id}.${finalExt}`;
  await bucket.put(filename, finalBuffer, { httpMetadata: { contentType: finalMime } });

  const record: ImageRecord = {
    id, userId: user.id, filename, mime: finalMime,
    size: finalSize, width: null, height: null,
    createdAt: Date.now(), autoDelete: autoDelete ? 1 : 0, deleteAfterDays: deleteDays,
  };
  await createImage(db, record);

  const baseUrl = getBaseUrl(c.req.raw);
  const fileUrl = `${baseUrl}/uploads/${filename}`;
  return json({ id, url: fileUrl, size: finalSize, format: finalExt, converted, markdown: `![image](${fileUrl})`, html: `<img src="${fileUrl}" alt="image" />`, bbcode: `[img]${fileUrl}[/img]` });
});

export default uploadRoutes;
