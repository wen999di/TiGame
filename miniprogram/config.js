// 部署后把这里改成 TiGame Cloudflare Worker 的 HTTPS 地址。
// 真机调试必须使用已在微信公众平台配置为 request/socket 合法域名的 HTTPS/WSS 域名。
module.exports = {
  API_BASE: 'https://tigame.YOUR-SUBDOMAIN.workers.dev',
};
