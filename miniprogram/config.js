// 正式与云端调试使用 TiGame Cloudflare Worker；本地调试脚本会在忽略目录生成临时副本并覆盖该值。
// 正式/体验环境必须使用已在微信公众平台配置为 request/socket 合法域名的 HTTPS/WSS 域名。
module.exports = {
  API_BASE: 'https://tigame.cavendish.dpdns.org',
};
