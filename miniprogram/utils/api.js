/* eslint-disable @typescript-eslint/no-require-imports */
const { API_BASE } = require('../config');

function normalizedBase() {
  return String(API_BASE || '').replace(/\/+$/, '');
}

function isPrivateHttpBase(base) {
  const match = /^http:\/\/([^/:]+)(?::\d+)?$/i.exec(base);
  if (!match) return false;
  const host = match[1].toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1') return true;
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
}

function assertConfigured() {
  const base = normalizedBase();
  if (/YOUR-SUBDOMAIN/i.test(base) || (!/^https:\/\//i.test(base) && !isPrivateHttpBase(base))) {
    throw new Error('TiGame API 必须使用 HTTPS，或本地调试使用 localhost/私有局域网 HTTP 地址');
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
  const base = assertConfigured().replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
  return `${base}/api/ws?roomId=${encodeURIComponent(roomId)}&ticket=${encodeURIComponent(ticket)}`;
}

module.exports = { request, getWsTicket, wsUrl, API_BASE };
