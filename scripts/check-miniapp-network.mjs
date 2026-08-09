#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const CONFIG_PATH = path.join(REPO_ROOT, "miniapp", "config", "index.ts");
const PAGE_JS_PATH = path.join(REPO_ROOT, "dist", "miniapp", "pages", "index", "index.js");

function fail(message) {
  console.error(`[miniapp-webview] ${message}`);
  process.exitCode = 1;
}

function defaultWebBase(configSource) {
  const match = configSource.match(/TIGAME_MINIAPP_WEB_BASE\s*\|\|\s*["']([^"']+)["']/);
  if (!match) throw new Error(`Cannot find default TIGAME_MINIAPP_WEB_BASE in ${CONFIG_PATH}`);
  return match[1];
}

const configSource = await readFile(CONFIG_PATH, "utf8");
const webBase = (process.env.TIGAME_MINIAPP_WEB_BASE || defaultWebBase(configSource)).replace(/\/$/, "");
const webUrl = new URL(webBase);
const host = webUrl.hostname;

if (webUrl.protocol !== "https:") fail(`Cloud/preview build must use HTTPS, got ${webBase}`);
if (host === "localhost" || host === "127.0.0.1" || isIP(host)) {
  fail(`Cloud/preview build must use a real HTTPS business-domain hostname, got ${host}`);
}

let pageSource = "";
try {
  pageSource = await readFile(PAGE_JS_PATH, "utf8");
} catch {
  fail(`Build output not found: ${PAGE_JS_PATH}. Run the Taro build first.`);
}
if (pageSource && !pageSource.includes(webBase)) {
  fail(`Built page does not contain expected WebView base ${webBase}. Check build-time environment overrides.`);
}

console.log("Mini Program WebView endpoint embedded in this build:");
console.log(`  业务域名: ${webUrl.origin}`);
console.log("Configure it in 微信公众平台 → 开发管理/开发设置 → 业务域名 before preview/experience/release testing.");
console.log("HTTP API and WebSocket now run inside the H5 WebView and use the website's normal HTTPS/WSS origin.");
