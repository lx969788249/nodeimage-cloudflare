# NodeJoker

Nodeimage 图床的 Cloudflare 版本，基于 Workers + D1 + R2 构建。

## 部署

### Workers 部署（推荐）

1. Fork 本仓库到你的 GitHub 账号

2. 进入 [Cloudflare Dashboard](https://dash.cloudflare.com)，选择 Workers & Pages → 创建应用程序 → Workers → 连接到 Git，授权并选择你 Fork 的仓库

3. 部署命令填写 `npm run deploy`，点击保存并部署

4. 部署完成后访问 Workers 默认域名（`xxx.workers.dev`），首次访问会自动初始化数据库

5. 默认账号 `admin`，密码 `admin`，进入设置页面修改密码

> Workers 的 `wrangler deploy` 会自动创建 D1 数据库与 R2 存储桶，无需手动操作。

### 命令行部署

```bash
git clone https://github.com/lx969788249/NodeJoker-cloudflare.git
cd NodeJoker-cloudflare
npm install
npx wrangler login
npm run deploy
```

### 本地开发

```bash
npm install
npm run dev
```

访问 `http://localhost:7878`

## 自动同步上游

Fork 后进入仓库 Actions 页面，启用 "Sync upstream" workflow，每天自动合并上游更新。

## 功能

- 拖拽 / 粘贴上传图片
- 支持 JPG、PNG、GIF、WebP、AVIF 格式，最大 100MB
- 图片自动按年月分目录存储
- 多格式链接复制（URL / HTML / Markdown / BBCode）
- API Key 管理，提供 RESTful 上传接口
- 暗黑模式
- 管理员面板（用户管理、品牌自定义）
- 备份与恢复

## 与原版差异

- 后端由 Express 迁移至 Hono，数据库由本地 SQLite 迁移至 Cloudflare D1，文件存储由本地磁盘迁移至 R2
- 认证由 Session Cookie 改为 Bearer Token + API Key
- 移除图片处理功能（WebP 压缩、水印、缩略图），原样存储上传文件
- 移除 tar.gz 备份，改为 JSON 格式备份恢复

## API

详见部署后的设置 → API 页面。

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/upload` | POST | 上传图片，Header `Authorization: Bearer <token>` |
| `/api/v1/list` | GET | 列出图片 |
| `/api/v1/delete/:id` | DELETE | 删除图片 |
