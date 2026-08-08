# TiGame 微信小程序

`miniprogram/` 是原生微信小程序客户端，继续使用本仓库现有的 Cloudflare Worker / Durable Object 房间后端，因此网页版与小程序版可以进入同一个房间。

## 1. 配置后端地址

编辑 `miniprogram/config.js`：

```js
module.exports = {
  API_BASE: 'https://tigame.cavendish.dpdns.org',
};
```

生产/真机环境必须是 HTTPS。小程序 WebSocket 会自动把该地址转换为 WSS。

在微信公众平台把同一个域名加入：

- **request 合法域名**：`https://tigame.cavendish.dpdns.org`
- **socket 合法域名**：`wss://tigame.cavendish.dpdns.org`

开发者工具本机调试时可以临时关闭“校验合法域名”，但真机预览/正式版不能依赖这个开关。

## 2. 打开微信开发者工具与 AppID

在 Windows 开发机上执行：

```bash
pnpm dev:miniprogram
```
脚本只从环境变量 `WECHAT_DEVTOOLS_CLI_PATH` 读取微信开发者工具 `cli.bat` 的完整路径，不再自动搜索、交互询问或写入本机配置文件。变量未设置、文件不存在或不是 `cli.bat` 时会直接报错。它会通过官方 CLI 的 `-o <项目目录>` 打开仓库根目录。

PowerShell 当前会话可这样设置：

```powershell
$env:WECHAT_DEVTOOLS_CLI_PATH = 'C:\Program Files\Tencent\微信开发者工具\cli.bat'
pnpm dev:miniprogram
```

如需持久保存到当前 Windows 用户环境变量，可使用 `setx WECHAT_DEVTOOLS_CLI_PATH "实际的 cli.bat 完整路径"`，然后重新打开终端。

在 Linux Docker 容器内无法直接启动 Windows 宿主机 GUI，可以先执行：

```bash
pnpm dev:miniprogram:check
```

仓库中的 `project.config.json` 暂时保持空 `appid`，不会借用其他项目的 AppID。没有 AppID 时可先用 `pnpm dev:miniprogram:check` 做工程结构、WXML/WXSS/JS 等静态检查。微信开发者工具 CLI 的 `-o <项目目录>` 要求项目已有 AppID，因此完全没有 AppID 时 `pnpm dev:miniprogram` 会直接报错，避免只打开开发者工具首页却误报“项目已打开”。

拿到测试号后，推荐在本机根目录创建已被 `.gitignore` 忽略的 `project.private.config.json`，只保存本机测试 AppID，例如：

```json
{
  "appid": "wx你的测试号AppID"
}
```

开发者工具会优先采用私有配置中的 AppID，`pnpm dev:miniprogram` 也会按相同优先级检查；正式 AppID 下来后再决定是否写入公共的 `project.config.json`。

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

- Repository Variable `WECHAT_MINIAPP_APP_ID`：小程序 AppID，例如 `wx...`。AppID 不是敏感信息，因此使用 Variable。
- Repository Secret `WECHAT_MINIAPP_UPLOAD_KEY`：微信公众平台生成的“小程序代码上传密钥”全文。它不是 App Secret，不要把 App Secret 填到这里。
- Repository Variable `WECHAT_MINIAPP_CI_ROBOT`：可选，固定上传机器人编号 `1` 到 `30`，默认 `1`。
- Repository Variable `WECHAT_MINIAPP_CI_RUNNER`：可选，默认 `ubuntu-latest`。如果代码上传密钥启用了 IP 白名单，应改为具有固定出口 IP 的 self-hosted runner label。
- Repository Variable `WECHAT_MINIAPP_CI_ENABLED`：最后设置为 `1` 才真正启用自动上传；未设置时 job 会跳过，不会因为尚未拿到 AppID/上传密钥而让 `main` CI 失败。

CI 会把上传密钥写入 Runner 临时目录并设置为仅当前用户可读，上传结束后无论成功失败都会删除。AppID 直接通过 `miniprogram-ci --appid` 传入，因此仓库中的 `project.config.json` 可以继续保持空 `appid`，本机调试仍可使用 `project.private.config.json`。

上传版本号格式为 `0.<GitHub Run Number>.<Run Attempt>`，说明中包含 `main` 与短 commit SHA。第一次成功上传后，到微信公众平台把固定 robot 上传的开发版本设为“体验版”一次；以后 CI 持续使用同一个 robot 上传即可更新同一体验入口。每次 workflow 还会保存 `wechat-trial-entry` Artifact，并在 Job Summary 中写出固定体验入口 URL。

启用顺序建议是：先配置 AppID、上传密钥和可选 robot/runner，确认上传密钥的 IP 白名单策略，再最后添加 `WECHAT_MINIAPP_CI_ENABLED=1`。小程序代码上传本身不需要微信 App Secret。
