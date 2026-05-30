// 从旧版 Docker 部署迁移数据到 Cloudflare 版
//
// 用法：把 db.sqlite 放到当前目录，然后:
//   node scripts/migrate.mjs ./db.sqlite
//
// 生成 migration.json 后在新版设置页面上传即可

import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';

const dbPath = process.argv[2] || './db.sqlite';

const db = new Database(dbPath);

const users = db.prepare('SELECT * FROM users').all();
const images = db.prepare('SELECT * FROM images ORDER BY createdAt DESC').all();
const settings = db.prepare('SELECT * FROM settings').all();
db.close();

// 去掉 thumbName 字段（新版不需要缩略图）
const migrated = images.map(({ thumbName, ...rest }) => rest);

const backup = {
  users,
  images: migrated,
  settings,
  exportedAt: new Date().toISOString(),
};

const outFile = `migration-${Date.now()}.json`;
writeFileSync(outFile, JSON.stringify(backup, null, 2));

console.log(`导出完成: ${outFile}`);
console.log(`  用户 ${users.length} 个，图片 ${migrated.length} 张`);

console.log(`
下一步:
1. 在新站点 https://nodejoker.lx969788249.workers.dev 登录后
   设置 → 备份 → 上传恢复备份 → 选择 ${outFile}
2. 把 uploads/ 目录上传到 R2（用 rclone 或后台网页上传）
`);
