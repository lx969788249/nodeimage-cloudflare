import type { D1Database } from '@cloudflare/workers-types';
import { hashPassword } from './crypto';
import { generateApiKey, getTodayRange } from './utils';

export interface User {
  id: string;
  username: string;
  passwordHash: string | null;
  apiKey: string;
  token: string | null;
  level: number;
  sessionVersion: number;
  createdAt: number;
}

export interface ImageRecord {
  id: string;
  userId: string;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  createdAt: number;
  autoDelete: number;
  deleteAfterDays: number | null;
}

export interface Branding {
  name: string;
  subtitle: string;
  icon: string;
  registrationEnabled: boolean;
}

export interface BackupConfig {
  intervalHours: number;
  keepCount: number;
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3AccessKey: string;
  s3SecretKey: string;
  webhookUrl: string;
}

// --- User operations ---

export async function getUser(db: D1Database, id: string): Promise<User | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>();
}

export async function getUserByUsername(db: D1Database, username: string): Promise<User | null> {
  return db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first<User>();
}

export async function getUserByApiKey(db: D1Database, apiKey: string): Promise<User | null> {
  return db.prepare('SELECT * FROM users WHERE apiKey = ?').bind(apiKey).first<User>();
}

export async function getUserByToken(db: D1Database, token: string): Promise<User | null> {
  return db.prepare('SELECT * FROM users WHERE token = ?').bind(token).first<User>();
}

export async function listUsers(db: D1Database): Promise<User[]> {
  const result = await db.prepare('SELECT * FROM users').all<User>();
  return result.results;
}

export async function createUser(
  db: D1Database,
  user: User
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO users (id, username, passwordHash, apiKey, token, level, sessionVersion, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(
      user.id,
      user.username,
      user.passwordHash,
      user.apiKey,
      user.token,
      user.level,
      user.sessionVersion,
      user.createdAt
    )
    .run();
}

export async function updateUser(
  db: D1Database,
  id: string,
  updates: Partial<Pick<User, 'username' | 'passwordHash' | 'apiKey' | 'token' | 'level' | 'sessionVersion'>>
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }
  if (fields.length === 0) return;
  values.push(id);
  await db
    .prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();
}

export async function deleteUser(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
}

// --- Image operations ---

export async function createImage(db: D1Database, img: ImageRecord): Promise<void> {
  await db
    .prepare(
      'INSERT INTO images (id, userId, filename, mime, size, width, height, createdAt, autoDelete, deleteAfterDays) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(
      img.id,
      img.userId,
      img.filename,
      img.mime,
      img.size,
      img.width ?? null,
      img.height ?? null,
      img.createdAt,
      img.autoDelete,
      img.deleteAfterDays ?? null
    )
    .run();
}

export async function listImagesByUser(
  db: D1Database,
  userId: string,
  offset: number,
  limit: number
): Promise<{ items: ImageRecord[]; total: number }> {
  const countResult = await db
    .prepare('SELECT COUNT(*) as count FROM images WHERE userId = ?')
    .bind(userId)
    .first<{ count: number }>();
  const total = countResult?.count ?? 0;

  const items = await db
    .prepare('SELECT * FROM images WHERE userId = ? ORDER BY createdAt DESC LIMIT ? OFFSET ?')
    .bind(userId, limit, offset)
    .all<ImageRecord>();

  return { items: items.results, total };
}

export async function getImageById(db: D1Database, id: string): Promise<ImageRecord | null> {
  return db.prepare('SELECT * FROM images WHERE id = ?').bind(id).first<ImageRecord>();
}

export async function deleteImagesByIds(db: D1Database, userId: string, ids: string[]): Promise<ImageRecord[]> {
  const placeholders = ids.map(() => '?').join(',');
  const toDelete = await db
    .prepare(`SELECT * FROM images WHERE userId = ? AND id IN (${placeholders})`)
    .bind(userId, ...ids)
    .all<ImageRecord>();

  if (toDelete.results.length > 0) {
    const deleteIds = toDelete.results.map((img) => img.id);
    const delPlaceholders = deleteIds.map(() => '?').join(',');
    await db
      .prepare(`DELETE FROM images WHERE id IN (${delPlaceholders})`)
      .bind(...deleteIds)
      .run();
  }
  return toDelete.results;
}

export async function deleteImageById(db: D1Database, userId: string, id: string): Promise<ImageRecord | null> {
  const img = await db
    .prepare('SELECT * FROM images WHERE userId = ? AND id = ?')
    .bind(userId, id)
    .first<ImageRecord>();
  if (img) {
    await db.prepare('DELETE FROM images WHERE id = ?').bind(id).run();
  }
  return img;
}

export async function countTodayUploads(
  db: D1Database,
  userId: string,
  start: number,
  end: number
): Promise<number> {
  const result = await db
    .prepare('SELECT COUNT(*) as count FROM images WHERE userId = ? AND createdAt >= ? AND createdAt <= ?')
    .bind(userId, start, end)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

export async function getStats(db: D1Database): Promise<{ total: number; today: number; totalSize: number }> {
  // 合并 COUNT 和 SUM 为一次查询（3→2 次查询）
  const overall = await db.prepare('SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as total FROM images').first<{ count: number; total: number }>();
  const { start, end } = getTodayRange();
  const todayResult = await db
    .prepare('SELECT COUNT(*) as count FROM images WHERE createdAt >= ? AND createdAt <= ?')
    .bind(start, end)
    .first<{ count: number }>();

  return {
    total: overall?.count ?? 0,
    today: todayResult?.count ?? 0,
    totalSize: overall?.total ?? 0,
  };
}

export async function listExpiredImages(db: D1Database): Promise<ImageRecord[]> {
  const now = Date.now();
  // 将过期判断下推到 SQL（createdAt + deleteAfterDays * 86400000 <= now）
  const result = await db
    .prepare('SELECT * FROM images WHERE autoDelete = 1 AND deleteAfterDays IS NOT NULL AND (createdAt + deleteAfterDays * 86400000) <= ?')
    .bind(now)
    .all<ImageRecord>();
  return result.results;
}

// --- Settings operations ---

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .bind(key, value)
    .run();
}

// --- Defaults ---

export async function ensureSchema(db: D1Database): Promise<void> {
  await db.prepare(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE,
    passwordHash TEXT,
    apiKey TEXT,
    token TEXT,
    level INTEGER DEFAULT 1,
    sessionVersion INTEGER DEFAULT 1,
    createdAt INTEGER
  )`).run();

  await db.prepare(`CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    userId TEXT,
    filename TEXT,
    mime TEXT,
    size INTEGER,
    width INTEGER,
    height INTEGER,
    createdAt INTEGER,
    autoDelete INTEGER DEFAULT 0,
    deleteAfterDays INTEGER
  )`).run();

  await db.prepare(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`).run();

  // 关键查询索引（D1 不会自动建索引）
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_users_token ON users(token)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_users_apiKey ON users(apiKey)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_images_userId ON images(userId)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_images_userId_createdAt ON images(userId, createdAt DESC)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_images_autoDelete ON images(autoDelete, deleteAfterDays)').run();
}

export async function ensureDefaultUser(db: D1Database): Promise<void> {
  const admin = await getUser(db, 'admin');
  if (!admin) {
    const passwordHash = await hashPassword('admin');
    const apiKey = generateApiKey();
    await createUser(db, {
      id: 'admin',
      username: 'admin',
      passwordHash,
      apiKey,
      token: null,
      level: 1,
      sessionVersion: 1,
      createdAt: Date.now(),
    });
  }
}

export async function getBranding(db: D1Database): Promise<Branding> {
  const raw = await getSetting(db, 'branding');
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      // fall through
    }
  }
  return {
    name: 'Nodeimage',
    subtitle: 'NodeSeek专用图床·克隆版',
    icon: '',
    registrationEnabled: false,
  };
}

export async function getBackupConfig(db: D1Database): Promise<BackupConfig> {
  const raw = await getSetting(db, 'backup');
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      // fall through
    }
  }
  return {
    intervalHours: 24,
    keepCount: 7,
    s3Endpoint: '',
    s3Region: 'auto',
    s3Bucket: '',
    s3AccessKey: '',
    s3SecretKey: '',
    webhookUrl: '',
  };
}
