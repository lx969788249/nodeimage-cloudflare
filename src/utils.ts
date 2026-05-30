import { customAlphabet } from 'nanoid';

export const nanoid = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 12);

function generateRandomString(length: number): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const array = crypto.getRandomValues(new Uint8Array(length));
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[array[i] % chars.length];
  }
  return result;
}

export function generateApiKey(): string {
  return generateRandomString(48);
}

export function generateToken(): string {
  return generateRandomString(48);
}

export function getTodayRange(): { start: number; end: number } {
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0);
  const end = start + 86400000 - 1;
  return { start, end };
}

export function getYearMonth(): { year: string; month: string } {
  const now = new Date();
  return {
    year: String(now.getUTCFullYear()),
    month: String(now.getUTCMonth() + 1).padStart(2, '0'),
  };
}

export function parseBool(val: unknown, defaultVal = true): boolean {
  if (val === undefined || val === null) return defaultVal;
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') return val.toLowerCase() === 'true';
  return Boolean(val);
}

export function getBaseUrl(request: Request, configBaseUrl?: string): string {
  if (configBaseUrl) return configBaseUrl;
  const url = new URL(request.url);
  const proto = request.headers.get('x-forwarded-proto') || url.protocol.slice(0, -1) || 'https';
  const referer = request.headers.get('referer') || '';
  const protocol = referer.startsWith('https://') ? 'https' : proto;
  const host = request.headers.get('x-forwarded-host') || url.host;
  return `${protocol}://${host}`;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export function errorJson(message: string, status = 400, extra?: Record<string, unknown>): Response {
  return json({ message, ...extra }, status);
}
