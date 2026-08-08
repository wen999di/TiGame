# TiGame 微信小程序

`miniprogram/` 是原生微信小程序客户端，继续使用本仓库现有的 Cloudflare Worker / Durable Object 房间后端，因此网页版与小程序版可以进入同一个房间。

## 1. 后端与调试模式

小程序正式/云端 API 固定为 `https://tigame.cavendish.dpdns.org`，源文件 `miniprogram/config.js` 保持该地址。WebSocket 会自动转换为 `wss://`。

Windows 开发机提供两种调试模式：

```bash
pnpm dev:miniprogram:cloud
pnpm dev:miniprogram:local
```

- `dev:miniprogram:cloud`：直接打开仓库小程序工程，连接 `https://tigame.cavendish.dpdns.org`。`pnpm dev:miniprogram` 保留为它的兼容别名。
- `dev:miniprogram:local`：自动启动或复用本地 `pnpm dev`（端口 `5173`），检测电脑私有局域网 IPv4，并生成 `.wechat-devtools/local/` 临时小程序工程，API 使用 `http://<电脑局域网IP>:5173`，WebSocket 使用对应的 `ws://`。生成工程会关闭合法域名校验，且 `miniprogram/` 源码变化会同步过去。`.wechat-devtools/local/` 仅用于调试，不应直接编辑；源码始终修改仓库中的 `miniprogram/`。

本地模式不会修改仓库中的云端 `miniprogram/config.js`，因此不会出现调试结束后忘记切回正式 API 的问题。真机本地调试时手机和电脑必须处于同一 LAN/Wi-Fi；若自动选择网卡不正确，可执行 `pnpm dev:miniprogram:local -- --ip 192.168.x.x`。Windows 防火墙需要允许 Node/Vite 的 TCP 5173 入站。

微信公众平台正式环境仍需配置：

- **request 合法域名**：`https://tigame.cavendish.dpdns.org`
- **socket 合法域名**：`wss://tigame.cavendish.dpdns.org`

## 2. 打开微信开发者工具与 AppID

两种 GUI 调试命令都只从环境变量 `WECHAT_DEVTOOLS_CLI_PATH` 读取微信开发者工具 `cli.bat` 的完整路径，不自动搜索、不交互询问，也不保存本机路径配置。变量未设置、文件不存在或不是 `cli.bat` 时直接报错。

PowerShell 当前会话示例：

```powershell
$env:WECHAT_DEVTOOLS_CLI_PATH = 'D:\Tencent\微信web开发者工具\cli.bat'
pnpm dev:miniprogram:cloud
# 或
pnpm dev:miniprogram:local
```

如需持久保存到当前 Windows 用户环境变量，可使用 `setx WECHAT_DEVTOOLS_CLI_PATH "实际的 cli.bat 完整路径"`，然后重新打开终端。

Linux Docker 容器不能直接启动 Windows GUI，可执行：

```bash
pnpm dev:miniprogram:check
pnpm dev:miniprogram:local -- --check
```

前者检查正式源码工程；后者额外生成并检查本地调试临时工程。仓库 `project.config.json` 已配置正式 AppID `wx3401664ce3ed7449`。

`project.private.config.json` 仍被 `.gitignore` 忽略，可在确有需要时作为本机覆盖；若其中残留其他 AppID，微信开发者工具会优先采用它，建议删除旧 `appid`。

## 3. 微信头像与昵称

新版本小程序不再通过 `wx.getUserProfile` 静默获取真实昵称头像。客户端采用微信当前提供的头像昵称填写能力：

- 头像：`button open-type="chooseAvatar"`
- 昵称：`input type="nickname"`

头像在客户端缩小后才随创建/加入请求进入房间，并由服务端再次限制为最多 4096 字符的图片 data URL，防止用户把超大内容写进 Durable Object 房间快照。用户不选择头像时仍可使用昵称首字作为头像。

## 4. 已覆盖功能

- 创建房间 / 输入房间码加入 / 小程序分享邀请
- 房主审核加入、拒绝、踢人、离开/结束房间
- 单次 WebSocket ticket、断线指数退避重连、原有 command/ack 协议
- 谁是卧底：设置、发牌、准备投票、投票、揭晓、下一局
- 不要做挑战：生命设置、开始、惩罚、换牌、奖励、弃牌提示、重开
- 麻将计分：给分、向所有人收取、确认/拒绝、重置准备、结账准备、结算建议

网页版不要求头像，因此旧客户端、旧 API 调用和已有房间数据保持兼容。

## 5. GitHub Actions 自动上传

仓库提供 `.github/workflows/deploy-miniapp.yml`。启用后，`main` 分支的小程序源码、项目配置或上传脚本发生变化时，会自动使用微信官方 `miniprogram-ci@2.1.31` 上传开发版本；也可以在 GitHub Actions 页面手动运行。TiGame 当前只有一套小程序环境，不区分 development / production。

需要在 GitHub Repository Settings -> Secrets and variables -> Actions 中配置：

- Repository Secret `WECHAT_MINIAPP_UPLOAD_KEY`：微信公众平台生成的“小程序代码上传密钥”全文。它不是 App Secret，不要把 App Secret 填到这里。AppID 直接读取仓库中的 `project.config.json`，不需要额外配置 GitHub Variable。
- Repository Variable `WECHAT_MINIAPP_CI_ROBOT`：可选，固定上传机器人编号 `1` 到 `30`，默认 `1`。
- Repository Variable `WECHAT_MINIAPP_CI_RUNNER`：可选，默认 `ubuntu-latest`。如果代码上传密钥启用了 IP 白名单，应改为具有固定出口 IP 的 self-hosted runner label。
- Repository Variable `WECHAT_MINIAPP_CI_ENABLED`：最后设置为 `1` 才真正启用自动上传；未设置时 job 会跳过，不会因为尚未拿到 AppID/上传密钥而让 `main` CI 失败。

CI 会把上传密钥写入 Runner 临时目录并设置为仅当前用户可读，上传结束后无论成功失败都会删除。Workflow 会从仓库 `project.config.json` 读取 AppID，再通过 `miniprogram-ci --appid` 显式传入，确保本机调试和 CI 使用同一个小程序身份。

上传版本号格式为 `0.<GitHub Run Number>.<Run Attempt>`，说明中包含 `main` 与短 commit SHA。第一次成功上传后，到微信公众平台把固定 robot 上传的开发版本设为“体验版”一次；以后 CI 持续使用同一个 robot 上传即可更新同一体验入口。每次 workflow 还会保存 `wechat-trial-entry` Artifact，并在 Job Summary 中写出固定体验入口 URL。

启用顺序建议是：先在 GitHub 配置上传密钥和可选 robot/runner，确认上传密钥的 IP 白名单策略，再最后添加 `WECHAT_MINIAPP_CI_ENABLED=1`。小程序代码上传本身不需要微信 App Secret。
