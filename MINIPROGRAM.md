# TiGame 微信小程序（WebView 壳）

TiGame 微信小程序不再把网页 React UI 编译成 WXML/WXSS。`miniapp/` 现在只是一个很薄的 Taro 4 微信壳：首次进入时用微信原生头像/昵称填写能力收集资料，之后用 `<web-view>` 全屏打开线上 TiGame 网页。大厅、创建/加入房间、全部游戏、动画、HTTP 和 WebSocket 都直接运行现有网页代码。

## 运行结构

```text
微信小程序
  └─ miniapp/ Taro 4 薄壳
      ├─ chooseAvatar + input[type=nickname]
      └─ web-view → https://tigame.cavendish.dpdns.org/
                         └─ app/page.tsx + Cloudflare Worker + GameRoom Durable Object
```

旧的 `@tarojs/plugin-html`、浏览器 BOM shim、Motion shim、React→WXML 布局兼容 CSS 已全部移除。小程序包不再编译 `app/page.tsx` 或 `app/game/*`。

## 微信资料桥接

微信不提供“小程序父页面实时 postMessage 到 web-view 网页”的通用接口，因此壳层把资料放在 WebView URL 的 fragment 中：

```text
#tigame-wx-profile=<encoded-json>
```

fragment 不会随 HTTP 请求发送到网站服务器。H5 首次加载后立即读取并从地址栏清除。头像会先在小程序端压缩到约 32–48px，并限制为不超过 4096 字符的 data URL。

H5 创建房间时发送 `hostAvatarData`，加入房间时发送 `avatarData`。服务端只把头像放入对应 `GameRoom` Durable Object 的房间快照；没有 D1/用户头像表。房间关闭或超时销毁时调用 Durable Object `storage.deleteAll()`，把房间状态、头像、ticket、alarm/存储元数据一起清空。

昵称/头像资料另外保留一份在用户自己的微信小程序本地 Storage 中，目的是下次打开不必重复选择；这份数据不会上传到长期用户数据库。

## 业务域名

正式 WebView 地址默认是：

```text
https://tigame.cavendish.dpdns.org
```

体验版、审核版和正式版发布前，必须在微信公众平台 **开发管理 → 开发设置 → 业务域名** 添加该 HTTPS 域名，并按后台要求完成校验。现在不再需要为 TiGame H5 API 单独配置小程序 `request` / `socket` 合法域名，因为请求和 WebSocket 都从 H5 WebView 内按普通网页同源方式发起。

`pnpm check:miniprogram:network` 会检查当前构建实际嵌入的 WebView 地址并打印应配置的业务域名。可用 `TIGAME_MINIAPP_WEB_BASE=https://...` 覆盖构建地址。

## 构建

```bash
pnpm check:miniprogram          # typecheck + Taro build + WebView 业务域名检查
pnpm build:miniprogram         # Taro watch，不自动打开开发者工具
pnpm dev:miniprogram:cloud     # watch + 打开微信开发者工具
pnpm dev:miniprogram:check     # 一次构建 + 工程结构检查
```

开发者工具工程仍位于仓库根目录，`project.config.json` 的 `miniprogramRoot` 指向 `dist/miniapp/`，AppID 为 `wx0f1f5b78c7a6c7cc`。

## 分享

壳层 `onShareAppMessage` 会读取微信传入的当前 `webViewUrl`。H5 进入房间后只在微信 WebView 环境把当前房间号同步到 `?invite=XXX-XXX`，因此右上角分享仍会生成 `/pages/index/index?invite=XXX-XXX`；接收者打开后，壳层把邀请码继续带入 H5。
