#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const OUTPUT_ROOT = path.join(REPO_ROOT, "dist", "miniapp");
const APP_CONFIG = path.join(OUTPUT_ROOT, "app.json");
const OPEN_SCRIPT = path.join(SCRIPT_DIR, "open-wechat-devtools.mjs");
const NETWORK_CHECK_SCRIPT = path.join(SCRIPT_DIR, "check-miniapp-network.mjs");
const CLOUD_API_BASE = "https://tigame.cavendish.dpdns.org";

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

function spawnPnpm(args, options = {}) {
  return spawn("corepack", ["pnpm", ...args], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
}

function terminate(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.unref();
  } else {
    child.kill("SIGTERM");
  }
}

async function waitForBuild(child) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Taro watch exited before producing app.json (code ${child.exitCode}).`);
    if (await exists(APP_CONFIG)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Taro output: ${APP_CONFIG}`);
}

function cloudEnv() {
  return {
    ...process.env,
    TIGAME_MINIAPP_API_BASE: CLOUD_API_BASE,
    TIGAME_MINIAPP_DEBUG: "1",
  };
}

async function runNodeScript(scriptPath, label, options = {}) {
  const child = spawn(process.execPath, [scriptPath], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    ...options,
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode ?? 1));
  });
  if (code !== 0) throw new Error(`${label} exited with code ${code}.`);
}

async function openDevTools() {
  await runNodeScript(OPEN_SCRIPT, "WeChat DevTools launcher");
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("dev:miniprogram must run on the Windows development machine. Use pnpm dev:miniprogram:check in the Linux container.");
  }

  await rm(OUTPUT_ROOT, { recursive: true, force: true });
  console.log(`Starting Taro 4 WeChat Mini Program watch build against ${CLOUD_API_BASE}...`);
  const watcher = spawnPnpm(["--filter", "@tigame/miniapp", "dev:weapp"], { env: cloudEnv() });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    terminate(watcher);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await waitForBuild(watcher);
    console.log(`Taro output ready: ${OUTPUT_ROOT}`);
    await runNodeScript(NETWORK_CHECK_SCRIPT, "Mini Program network check", { env: cloudEnv() });
    await openDevTools();
    console.log("Taro watch is active; edits to shared app/ React code will rebuild the Mini Program.");
    const code = await new Promise((resolve) => watcher.once("exit", (exitCode) => resolve(exitCode ?? 0)));
    if (!stopping && code !== 0) throw new Error(`Taro watch exited with code ${code}.`);
  } finally {
    stop();
  }
}

main().catch((error) => {
  console.error(`\n[miniapp-cloud] ${error.message}`);
  process.exitCode = 1;
});
