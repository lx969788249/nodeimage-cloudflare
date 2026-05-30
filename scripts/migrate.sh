#!/bin/bash
# 旧版 Nodeimage Docker → NodeJoker Cloudflare 数据迁移
#
# 用法:
#   1. 在旧版站点后台 → 备份 → 打包下载备份（得到 tar.gz）
#   2. tar xzf backup-xxx.tar.gz
#   3. ./scripts/migrate.sh data/db.sqlite
#   4. 在新版站点上传生成的 migration.json
#
set -e

DB="${1:-data/db.sqlite}"

if ! command -v sqlite3 &>/dev/null; then
  echo "需要 sqlite3，安装: brew install sqlite3 或 apt install sqlite3"
  exit 1
fi

echo "读取 $DB ..."

sqlite3 "$DB" -json "SELECT * FROM users" > /tmp/_mj_users.json
sqlite3 "$DB" -json "SELECT * FROM images ORDER BY createdAt DESC" > /tmp/_mj_images.json
sqlite3 "$DB" -json "SELECT * FROM settings" > /tmp/_mj_settings.json

node -e "
const fs = require('fs');
const users = JSON.parse(fs.readFileSync('/tmp/_mj_users.json'));
const images = JSON.parse(fs.readFileSync('/tmp/_mj_images.json')).map(
  ({thumbName, ...r}) => ({...r, autoDelete: r.autoDelete || 0})
);
const settings = JSON.parse(fs.readFileSync('/tmp/_mj_settings.json'));
fs.writeFileSync('migration.json', JSON.stringify({users, images, settings, exportedAt: new Date().toISOString()}, null, 2));
console.log('✅ migration.json 已生成（' + users.length + ' 用户, ' + images.length + ' 图片）');
"

rm -f /tmp/_mj_users.json /tmp/_mj_images.json /tmp/_mj_settings.json

echo ""
echo "下一步:"
echo "  1. 登录新版站点 → 设置 → 备份 → 上传恢复备份 → 选择 migration.json"
echo "  2. 把 uploads/ 目录上传到 R2 存储桶 nodeimage-uploads"
