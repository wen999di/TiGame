# TiGame 微信小程序（Taro 4）

TiGame 微信小程序现在使用 **Taro 4.2.1 + React**。旧的原生 `miniprogram/` 客户端已经删除；小程序入口只负责平台适配，主界面和游戏业务直接编译仓库现有的 `app/page.tsx`、`app/game/*` 等网页 React/TypeScript 源码。

## 代码结构

```text
app/                         网页端与小程序共同使用的 React/游戏源码
  page.tsx                   大厅、房间、游戏主界面（共享）
  game/                      游戏逻辑（共享）
  platform/portal.ts         Web 端 Portal 实现
miniapp/                     Taro 4 微信小程序壳层
  config/index.ts            Taro 构建、共享源码 loader、平台别名
  src/pages/index/index.tsx  小程序页面入口，直接 import app/page.tsx
  src/platform.ts            request/WebSocket/扫码/存储等 Taro 适配
  src/shims/                 少量 DOM/Motion 小程序适配
project.config.json          微信开发者工具工程配置，指向 dist/miniapp/
dist/miniapp/                Taro 生成物（忽略提交，不要直接编辑）
```

`@tarojs/plugin-html` 负责将网页 React 中已有的 HTML JSX 标签映射到小程序运行时，所以不会再维护一套 WXML/WXSS/JS 游戏界面。Taro 4.2.1 的 React renderer 使用 React 18，因此 `miniapp/` workspace 固定 React 18.3.1；网页根工程继续使用 React 19，两者通过 workspace 隔离。

## 正式/云端构建

正式小程序连接：

- HTTP API：`https://tigame.cavendish.dpdns.org`
- WebSocket：`wss://tigame.cavendish.dpdns.org`

常用命令：

```bash
pnpm check:miniprogram          # TypeScript 检查 + 一次性 Taro weapp 构建，输出 dist/miniapp/
pnpm build:miniprogram         # Taro watch，不自动打开微信开发者工具
pnpm build:miniprogram:cloud   # 同上
pnpm dev:miniprogram:cloud     # Taro watch + 自动打开微信开发者工具
pnpm dev:miniprogram           # 上一条的兼容别名
pnpm dev:miniprogram:check     # 构建后仅检查微信工程结构，容器内可运行
```

`build:miniprogram` 会保留 Taro 自身的编译进度和错误输出，并持续 watch `miniapp/` 与共享的 `app/` 源码。

微信公众平台正式环境仍需配置：

- **request 合法域名**：`https://tigame.cavendish.dpdns.org`
- **socket 合法域名**：`wss://tigame.cavendish.dpdns.org`

## 本地 Worker 联调

Windows 开发机可运行：

```bash
pnpm dev:miniprogram:local
```

脚本会：

1. 启动或复用本地 `pnpm dev`（5173）；
2. 自动选择可从局域网访问的私有 IPv4；
3. 用 `TIGAME_MINIAPP_API_BASE=http://<电脑IP>:5173` 启动同一个 Taro 工程；
4. 把临时产物写入 `.wechat-devtools/local/miniprogram/`；
5. 生成关闭 URL 校验的 `.wechat-devtools/local/project.config.json`；
6. 打开微信开发者工具并持续 Taro watch。

只构建/watch、不自动打开 DevTools：

```bash
pnpm build:miniprogram:local
```

指定网卡：

```bash
pnpm dev:miniprogram:local -- --ip 192.168.x.x
```

在 Linux/Docker 中验证本地工程生成逻辑：

```bash
pnpm dev:miniprogram:local -- --check
```

`.wechat-devtools/` 和 `dist/` 都是生成目录，不要直接修改。真机访问本地 Worker 时，手机和电脑需在同一 LAN/Wi-Fi，并确保 Windows 防火墙允许 5173 入站。

## 微信开发者工具

GUI 命令只读取环境变量 `WECHAT_DEVTOOLS_CLI_PATH`，它必须指向微信开发者工具的 `cli.bat`。

PowerShell 示例：

```powershell
$env:WECHAT_DEVTOOLS_CLI_PATH = 'D:\Tencent\微信web开发者工具\cli.bat'
pnpm dev:miniprogram:cloud
```

Linux Docker 无法直接启动 Windows GUI，可使用 `pnpm dev:miniprogram:check`。仓库 `project.config.json` 已配置 AppID `wx3401664ce3ed7449`；本机 `project.private.config.json` 如存在 AppID，会被微信开发者工具优先采用。

## 平台适配边界

共享页面中的房间和游戏状态机仍只有一份。小程序层仅处理 Web 与微信运行时不同的能力：

- `fetch` → `Taro.request`
- `WebSocket` → `Taro.connectSocket` / `SocketTask`
- `localStorage` → 微信同步 Storage
- 扫码 → `Taro.scanCode`
- 剪贴板、振动、网络状态 → 对应 Taro API
- Web Portal / Motion / SVG 辅助动画 → 小程序安全降级，不复制业务逻辑
- 房间邀请 → 微信右上角分享，分享路径携带 `invite` 参数

因此新增游戏、规则或绝大多数 UI 调整应优先修改 `app/`；只有涉及微信专属能力时才修改 `miniapp/src/`。

## GitHub Actions 自动上传

`.github/workflows/deploy-miniapp.yml` 会在共享 React、小程序适配层、Taro 配置或项目配置变化时执行：

1. `pnpm install --frozen-lockfile`
2. `pnpm run check:miniprogram` 生成 `dist/miniapp/`
3. `miniprogram-ci@2.1.31` 按根 `project.config.json` 的 `miniprogramRoot` 上传

需要配置：

- Secret `WECHAT_MINIAPP_UPLOAD_KEY`：微信公众平台“小程序代码上传密钥”全文；
- Variable `WECHAT_MINIAPP_CI_ROBOT`：可选，1–30，默认 1；
- Variable `WECHAT_MINIAPP_CI_RUNNER`：可选，默认 `ubuntu-latest`；
- Variable `WECHAT_MINIAPP_CI_ENABLED=1`：启用自动上传。

版本号仍为 `0.<GitHub Run Number>.<Run Attempt>`。上传密钥只写入 Runner 临时目录并在任务结束时删除。
