/* eslint-disable @typescript-eslint/no-require-imports */
const { API_BASE } = require('../config');

function normalizedBase() {
  return String(API_BASE || '').replace(/\/+$/, '');
}

function assertConfigured() {
  const base = normalizedBase();
  if (!/^https:\/\//i.test(base) || /YOUR-SUBDOMAIN/i.test(base)) {
    throw new Error('请先在 miniprogram/config.js 配置 TiGame 的 HTTPS Worker 地址');
  }
  return base;
}

function request(path, options = {}) {
  let base;
  try { base = assertConfigured(); } catch (error) { return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${base}${path}`,
      method: options.method || 'GET',
      data: options.data,
      timeout: options.timeout || 10000,
      header: {
        'content-type': 'application/json',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.header || {}),
      },
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.data);
        else {
          const message = res.data && res.data.error ? res.data.error : `请求失败（${res.statusCode}）`;
          const error = new Error(message);
          error.statusCode = res.statusCode;
          reject(error);
        }
      },
      fail(error) { reject(new Error(error.errMsg || '网络请求失败')); },
    });
  });
}

async function getWsTicket(session) {
  const q = `?roomId=${encodeURIComponent(session.roomId)}&playerId=${encodeURIComponent(session.playerId)}`;
  const data = await request(`/api/ws-ticket${q}`, { method: 'POST', token: session.token });
  if (!data || !data.ticket) throw new Error('无法获取实时连接凭证');
  return data.ticket;
}

function wsUrl(roomId, ticket) {
  const base = assertConfigured().replace(/^https:/i, 'wss:');
  return `${base}/api/ws?roomId=${encodeURIComponent(roomId)}&ticket=${encodeURIComponent(ticket)}`;
}

module.exports = { request, getWsTicket, wsUrl, API_BASE };
