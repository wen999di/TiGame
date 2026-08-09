#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const GENERATED_ROOT = path.join(REPO_ROOT, ".wechat-devtools", "local");
const GENERATED_MINIAPP = path.join(GENERATED_ROOT, "miniprogram");
const GENERATED_APP_CONFIG = path.join(GENERATED_MINIAPP, "app.json");
const OPEN_SCRIPT = path.join(SCRIPT_DIR, "open-wechat-devtools.mjs");
const LOCAL_PORT = 5173;
const LOOPBACK_BASE = `http://127.0.0.1:${LOCAL_PORT}`;

function printHelp() {
  console.log(`Usage: pnpm dev:miniprogram:local [options]\n\nOptions:\n  --ip <IPv4>   Use a specific private LAN IPv4 address\n  --check       Build and validate the local Taro DevTools project only\n  --no-open     Keep Taro/local-server watch running without opening WeChat DevTools\n  --help        Show this help\n\nNormal mode starts or reuses TiGame on port ${LOCAL_PORT}, detects a LAN address,\nbuilds the Taro Mini Program against http://<PC-IP>:${LOCAL_PORT}, and opens DevTools.`);
}

function parseArgs(argv) {
  const result = { ip: "", check: false, noOpen: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg === "--check") result.check = true;
    else if (arg === "--no-open") result.noOpen = true;
    else if (arg === "--ip") {
      result.ip = argv[++index] || "";
      if (!result.ip) throw new Error("--ip requires a private IPv4 address.");
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return result;
}

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

async function isTiGameHealthy(base) {
  try {
    const response = await fetch(`${base}/`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return false;
    const body = await response.text();
    return body.includes("TiGame") || body.includes("线下聚会小游戏辅助器");
  } catch { return false; }
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
  } else child.kill("SIGTERM");
}

async function waitForExit(child, label) {
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode ?? 1));
  });
  if (code !== 0) throw new Error(`${label} exited with code ${code}.`);
}

async function waitForBuild(child) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Taro watch exited before producing app.json (code ${child.exitCode}).`);
    if (await exists(GENERATED_APP_CONFIG)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Taro output: ${GENERATED_APP_CONFIG}`);
}

async function waitForLocalServer(server) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Local TiGame server exited before becoming ready (code ${server.exitCode}).`);
    if (await isTiGameHealthy(LOOPBACK_BASE)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for TiGame at ${LOOPBACK_BASE}.`);
}

function isPrivateIPv4(address) {
  if (isIP(address) !== 4) return false;
  const parts = address.split(".").map(Number);
  if (parts[0] === 10) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
}

function interfaceScore(name) {
  let score = 0;
  if (/wi-?fi|wlan|wireless|无线|ethernet|以太网/i.test(name)) score -= 20;
  if (/vethernet|wsl|docker|hyper-v|virtualbox|vmware|tailscale|zerotier|loopback/i.test(name)) score += 100;
  return score;
}

function lanCandidates(override) {
  if (override) {
    if (!isPrivateIPv4(override)) throw new Error(`--ip must be a private IPv4 address such as 192.168.x.x: ${override}`);
    return [{ name: "--ip", address: override, score: -1000 }];
  }
  const candidates = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      const ipv4 = entry.family === "IPv4" || entry.family === 4;
      if (!ipv4 || entry.internal || !isPrivateIPv4(entry.address)) continue;
      candidates.push({ name, address: entry.address, score: interfaceScore(name) });
    }
  }
  return candidates.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
}

async function findReachableLanCandidate(candidates) {
  for (const candidate of candidates) {
    if (await isTiGameHealthy(`http://${candidate.address}:${LOCAL_PORT}`)) return candidate;
  }
  return null;
}

async function prepareGeneratedProject() {
  await mkdir(GENERATED_ROOT, { recursive: true });
  const config = JSON.parse(await readFile(path.join(REPO_ROOT, "project.config.json"), "utf8"));
  config.miniprogramRoot = "miniprogram/";
  config.projectname = `${config.projectname || "TiGame-Taro-WeChat"}-Local`;
  config.setting ||= {};
  config.setting.urlCheck = false;
  await writeFile(path.join(GENERATED_ROOT, "project.config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function taroEnv(apiBase) {
  return {
    ...process.env,
    TIGAME_MINIAPP_API_BASE: apiBase,
    TIGAME_MINIAPP_OUTPUT_ROOT: "../.wechat-devtools/local/miniprogram",
  };
}

async function buildLocalOnce(apiBase) {
  await rm(GENERATED_MINIAPP, { recursive: true, force: true });
  const child = spawnPnpm(["--filter", "@tigame/miniapp", "build:weapp"], { env: taroEnv(apiBase) });
  await waitForExit(child, "Taro local build");
  if (!(await exists(GENERATED_APP_CONFIG))) throw new Error(`Taro build did not create ${GENERATED_APP_CONFIG}.`);
}

function startLocalWatch(apiBase) {
  return spawnPnpm(["--filter", "@tigame/miniapp", "dev:weapp"], { env: taroEnv(apiBase) });
}

async function runOpenScript(checkOnly = false) {
  const args = [OPEN_SCRIPT, "--project", GENERATED_ROOT];
  if (checkOnly) args.push("--check");
  const child = spawn(process.execPath, args, { cwd: REPO_ROOT, stdio: "inherit" });
  await waitForExit(child, "Mini Program launcher");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { printHelp(); return; }

  await prepareGeneratedProject();
  if (options.check) {
    await buildLocalOnce(LOOPBACK_BASE);
    await runOpenScript(true);
    console.log(`Generated Taro local Mini Program project: ${GENERATED_ROOT}`);
    return;
  }

  if (process.platform !== "win32") {
    throw new Error("dev:miniprogram:local must run on the Windows development machine. Use --check inside the Linux container.");
  }

  let server = null;
  let ownsServer = false;
  let watcher = null;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    terminate(watcher);
    if (ownsServer) terminate(server);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    if (await isTiGameHealthy(LOOPBACK_BASE)) {
      console.log(`Reusing TiGame local server at ${LOOPBACK_BASE}.`);
    } else {
      console.log(`Starting TiGame local server on 0.0.0.0:${LOCAL_PORT}...`);
      server = spawnPnpm(["dev", "--", "--port", String(LOCAL_PORT), "--strictPort"]);
      ownsServer = true;
      await waitForLocalServer(server);
    }

    const candidates = lanCandidates(options.ip);
    if (candidates.length === 0) throw new Error("No private LAN IPv4 address detected. Connect to LAN/Wi-Fi or pass --ip <IPv4>.");
    const lan = await findReachableLanCandidate(candidates);
    if (!lan) {
      throw new Error(`TiGame is healthy on ${LOOPBACK_BASE} but not reachable through a private LAN address. Check Windows Firewall/private-network access or retry with --ip <PC-LAN-IP>.`);
    }

    const apiBase = `http://${lan.address}:${LOCAL_PORT}`;
    await rm(GENERATED_MINIAPP, { recursive: true, force: true });
    watcher = startLocalWatch(apiBase);
    await waitForBuild(watcher);

    console.log(`\nLocal Mini Program API/WebSocket base: ${apiBase}`);
    console.log(`Detected LAN interface: ${lan.name}`);
    console.log(`Generated Taro project: ${GENERATED_ROOT}`);
    console.log("DevTools URL/domain validation: off for this generated local project");
    if (options.noOpen) console.log("WeChat DevTools auto-open: disabled");
    else await runOpenScript(false);

    console.log("Taro watch is active; edits to shared app/ React code will rebuild the local Mini Program.");
    console.log("Keep phone and PC on the same LAN/Wi-Fi for true-device debugging. Press Ctrl+C to stop.\n");
    await new Promise((resolve, reject) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
      watcher.once("exit", (code) => stopping ? resolve() : reject(new Error(`Taro local watch exited unexpectedly (code ${code ?? 0}).`)));
      if (server) server.once("exit", (code) => stopping ? resolve() : reject(new Error(`Local TiGame server exited unexpectedly (code ${code ?? 0}).`)));
    });
  } finally { stop(); }
}

main().catch((error) => {
  console.error(`\n[miniapp-local] ${error.message}`);
  process.exitCode = 1;
});
