import type { Context, Next } from 'hono';
import { getUserByToken, getUserByApiKey } from './db';
import type { AuthUser, Env } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function authenticate(c: any): Promise<AuthUser | null> {
  const db = c.env.DB;

  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const user = await getUserByToken(db, token);
    if (user) {
      return { id: user.id, username: user.username, level: user.level || 1, apiKey: user.apiKey, sessionVersion: user.sessionVersion || 1 };
    }
  }

  const apiKey = c.req.header('X-API-Key') || c.req.header('x-api-key');
  if (apiKey) {
    const user = await getUserByApiKey(db, apiKey);
    if (user) {
      return { id: user.id, username: user.username, level: user.level || 1, apiKey: user.apiKey, sessionVersion: user.sessionVersion || 1 };
    }
  }

  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function authMiddleware(c: any, next: Next): Promise<void> {
  const user = await authenticate(c);
  if (!user) {
    c.status(401);
    return c.json({ message: 'AUTH_REQUIRED' });
  }
  c.set('user', user);
  await next();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function optionalAuth(c: any, next: Next): Promise<void> {
  const user = await authenticate(c);
  c.set('user', user);
  await next();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function requireAdmin(c: any, next: Next): Promise<void> {
  const user = c.get('user') as AuthUser | null;
  if (!user || (user.id !== 'admin' && user.level < 9)) {
    c.status(403);
    c.json({ message: '仅管理员可操作' });
    return;
  }
  await next();
}
