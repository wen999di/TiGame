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

当前 `project.config.json` 的 `appid` 保持为空，不会借用其他项目的 AppID。没有正式 AppID 时可以先做工程结构、WXML/WXSS/JS 等静态检查。微信开发者工具的项目导入、预览、真机以及依赖帐号身份的能力，建议先申请微信提供的测试号，之后再替换为正式 AppID。

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
