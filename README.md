# TiGame

线下聚会小游戏辅助器：房主创建房间、邀请好友加入后，在房间内选择游戏一起游玩。目前包含：

- **谁是卧底**：词语描述与投票推理；
- **不要做挑战**：抽取禁忌动作，犯规扣命，坚持到最后者获胜；
- **麻将计分板**：给其他玩家送分，自动记录给分历史。

## 项目结构

```
app/                   前端页面与客户端逻辑
  page.tsx             主界面（大厅与各游戏页面）
  game/                各小游戏的纯逻辑模块
worker/                服务端（Cloudflare Worker）
  game-room.ts         房间状态管理（Durable Object）
  index.ts             WebSocket 接入
app/api/               创建房间、提交加入申请等 HTTP 接口
tests/                 单元测试
scripts/               构建与部署脚本
```

## 本地调试

本地开发使用 Vite + Cloudflare 插件（Miniflare），一条命令同时跑起前端、Worker、Durable Object 和 WebSocket，无需真实部署。

### 环境要求

- Node.js >= 22.13（推荐 22 或 24 的 LTS 版本）
- pnpm 10.15（仓库通过 Corepack 锁定版本；首次可执行 `corepack enable`）

### 首次准备

```bash
pnpm install
```

`wrangler.jsonc` 是本地运行与部署共用的 Worker 配置（Durable Object 绑定等）。仓库当前已有该文件，但它被 `.gitignore` 忽略，克隆后若缺失，请按下方「部署」章节的配置自行创建，否则 `pnpm dev` 会因缺少配置而失败。

### 启动本地服务

```bash
pnpm dev
```

启动后：

- 本机访问：<http://localhost:5173/>
- 手机等局域网设备访问：启动时终端里的 `Network` 地址（如 <http://192.168.0.103:5173/>），Vite 已监听 `0.0.0.0`

验证是否跑通：打开首页创建房间，再用另一个浏览器窗口或手机加入该房间，房主通过加入申请后即可进入游戏。本地房间数据保存在 `.wrangler/` 目录，删除该目录可重置所有本地房间状态。

### 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 启动本地开发服务（前端 + Worker，支持热更新） |
| `pnpm test` | 构建后运行单元测试 |
| `pnpm lint` | ESLint 代码检查 |
| `pnpm build` | 构建生产产物（同 `build:cloudflare`） |
| `pnpm deploy:cloudflare` | 构建并部署到 Cloudflare |
| `pnpm dev:miniprogram` | Windows 上自动打开微信开发者工具并载入本项目 |
| `pnpm dev:miniprogram:check` | 仅检查小程序工程结构（容器内可运行） |

### 调试提示

- 用两个浏览器窗口（或隐身窗口 + 手机）分别扮演房主和加入者，方便联调 WebSocket 与房间状态同步。
- 前端与 Worker 的日志都会输出在 `pnpm dev` 的终端；房间逻辑在 `worker/game-room.ts`，HTTP 接口在 `app/api/`，WebSocket 入口在 `worker/index.ts`。
- 修改 `app/` 下代码会触发前端热更新，修改 `worker/` 下代码会自动重载 Worker（未生效时重启 `pnpm dev` 即可）。
- 局域网设备访问失败时，检查 Windows 防火墙是否放行 Node.js，并确认设备与电脑在同一网络。

## 部署

`wrangler.jsonc` 是 Cloudflare Worker 的部署配置（项目名、Durable Object 等），需要手动准备，不会自动生成。该文件未纳入版本控制，克隆仓库后需要自行创建。

1. 登录 Cloudflare：

   ```bash
   pnpm exec wrangler login
   ```

2. 在项目根目录新建 `wrangler.jsonc`：

   ```jsonc
   {
     "$schema": "./node_modules/wrangler/config-schema.json",
     "name": "tigame",
     "main": "./worker/index.ts",
     "compatibility_date": "2026-05-22",
     "compatibility_flags": ["nodejs_compat"],
     "workers_dev": true,
     "preview_urls": false,
     "assets": { "binding": "ASSETS" },
     "durable_objects": {
       "bindings": [{ "name": "ROOM", "class_name": "GameRoom" }]
     },
     "migrations": [{ "tag": "v1", "new_sqlite_classes": ["GameRoom"] }]
   }
   ```
3. 安装依赖并部署：

   ```bash
   pnpm install
   pnpm build
   pnpm deploy:cloudflare
   ```

## 微信小程序

仓库内已包含原生微信小程序客户端 `miniprogram/`，与网页版复用同一套 Cloudflare Worker / Durable Object 房间后端。
配置、合法域名以及头像昵称能力说明见 [`MINIPROGRAM.md`](./MINIPROGRAM.md)。
