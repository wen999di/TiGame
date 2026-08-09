#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const CONFIG_PATH = path.join(REPO_ROOT, "miniapp", "config", "index.ts");
const APP_JS_PATH = path.join(REPO_ROOT, "dist", "miniapp", "app.js");

function fail(message) {
  console.error(`[miniapp-network] ${message}`);
  process.exitCode = 1;
}

function defaultApiBase(configSource) {
  const match = configSource.match(/TIGAME_MINIAPP_API_BASE\s*\|\|\s*["']([^"']+)["']/);
  if (!match) throw new Error(`Cannot find default TIGAME_MINIAPP_API_BASE in ${CONFIG_PATH}`);
  return match[1];
}

const configSource = await readFile(CONFIG_PATH, "utf8");
const apiBase = (process.env.TIGAME_MINIAPP_API_BASE || defaultApiBase(configSource)).replace(/\/$/, "");
const apiUrl = new URL(apiBase);
const host = apiUrl.hostname;
const socketProtocol = apiUrl.protocol === "https:" ? "wss:" : "ws:";
const socketBase = `${socketProtocol}//${apiUrl.host}`;

if (apiUrl.protocol !== "https:") fail(`Cloud/true-device build must use HTTPS, got ${apiBase}`);
if (host === "localhost" || host === "127.0.0.1" || isIP(host)) {
  fail(`Cloud/true-device build must use a real HTTPS hostname, got ${host}`);
}

let appSource = "";
try {
  appSource = await readFile(APP_JS_PATH, "utf8");
} catch {
  fail(`Build output not found: ${APP_JS_PATH}. Run the Taro build first.`);
}
if (appSource && !appSource.includes(apiBase)) {
  fail(`Built app.js does not contain expected API base ${apiBase}. Check build-time environment overrides.`);
}

console.log("Mini Program network endpoints embedded in this build:");
console.log(`  request 合法域名: ${apiUrl.origin}`);
console.log(`  socket 合法域名:  ${socketBase}`);
console.log("Configure both in 微信公众平台 → 开发管理/开发设置 → 服务器域名 before preview/experience/release testing.");
