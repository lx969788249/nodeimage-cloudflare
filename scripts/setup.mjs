// 部署前自动创建 D1 + R2 资源
// Cloudflare Workers Git 集成环境会自动注入 CLOUDFLARE_API_TOKEN 和 CLOUDFLARE_ACCOUNT_ID

import { readFile, writeFile } from 'node:fs/promises';

const API = 'https://api.cloudflare.com/client/v4';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;

if (!TOKEN || !ACCOUNT_ID) {
  console.log('未检测到 CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID，跳过自动配置（可能是本地开发）');
  process.exit(0);
}

const headers = {
  'Authorization': `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, { headers, ...opts });
  return res.json();
}

// --- D1 ---
console.log('检查 D1 数据库...');
const d1List = await api(`/accounts/${ACCOUNT_ID}/d1/database`);
let dbId = d1List.result?.find(d => d.name === 'nodeimage-db')?.uuid;

if (!dbId) {
  console.log('创建 D1 数据库 nodeimage-db...');
  const created = await api(`/accounts/${ACCOUNT_ID}/d1/database`, {
    method: 'POST',
    body: JSON.stringify({ name: 'nodeimage-db' }),
  });
  dbId = created.result?.uuid;
  if (!dbId) {
    console.error('D1 创建失败:', JSON.stringify(created.errors || created));
    process.exit(1);
  }
}
console.log(`D1 database_id: ${dbId}`);

// --- R2 ---
console.log('检查 R2 存储桶...');
const r2List = await api(`/accounts/${ACCOUNT_ID}/r2/buckets`);
let bucketExists = r2List.result?.buckets?.some(b => b.name === 'nodeimage-uploads');

if (!bucketExists) {
  console.log('创建 R2 存储桶 nodeimage-uploads...');
  await api(`/accounts/${ACCOUNT_ID}/r2/buckets`, {
    method: 'POST',
    body: JSON.stringify({ name: 'nodeimage-uploads' }),
  });
}
console.log('R2 bucket: nodeimage-uploads');

// --- 更新 wrangler.toml ---
const toml = await readFile('wrangler.toml', 'utf-8');
const updated = toml.replace(
  /database_id = ".*"/,
  `database_id = "${dbId}"`
);
await writeFile('wrangler.toml', updated);
console.log('wrangler.toml 已更新');
console.log('资源准备完毕，开始部署...');
