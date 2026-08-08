#!/usr/bin/env node

import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const MINIAPP_SOURCE = path.join(REPO_ROOT, "miniprogram");
const GENERATED_ROOT = path.join(REPO_ROOT, ".wechat-devtools", "local");
const GENERATED_MINIAPP = path.join(GENERATED_ROOT, "miniprogram");
const OPEN_SCRIPT = path.join(SCRIPT_DIR, "open-wechat-devtools.mjs");
const LOCAL_PORT = 5173;
const LOOPBACK_BASE = `http://127.0.0.1:${LOCAL_PORT}`;

function printHelp() {
  console.log(`Usage: pnpm dev:miniprogram:local [options]\n\nOptions:\n  --ip <IPv4>   Use a specific private LAN IPv4 address\n  --check       Generate and validate the local DevTools project only\n  --no-open     Build/sync and keep watching without opening WeChat DevTools\n  --help        Show this help\n\nThe normal mode starts or reuses TiGame on port ${LOCAL_PORT}, detects a LAN address,\nand opens a generated Mini Program project against http://<PC-IP>:${LOCAL_PORT}.`);
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
    }
    else throw new Error(`Unknown option: ${arg}`);
  }
  return result;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isTiGameHealthy(base) {
  try {
    const response = await fetch(`${base}/`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return false;
    const body = await response.text();
    return body.includes("TiGame") || body.includes("线下聚会小游戏辅助器");
  } catch {
    return false;
  }
}

function cmdSpawn(command, options = {}) {
  const comSpec = process.env.ComSpec || "cmd.exe";
  return spawn(comSpec, ["/d", "/s", "/c", command], {
    cwd: REPO_ROOT,
    windowsHide: false,
    ...options,
  });
}

function terminateProcessTree(pid) {
  if (!pid) return;
  const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  killer.unref();
}

async function waitForLocalServer(server) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Local TiGame server exited before becoming ready (code ${server.exitCode}).`);
    }
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
    if (!isPrivateIPv4(override)) {
      throw new Error(`--ip must be a private IPv4 address such as 192.168.x.x: ${override}`);
    }
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

async function syncGeneratedProject(apiBase) {
  await mkdir(GENERATED_ROOT, { recursive: true });
  if (!(await exists(path.join(GENERATED_ROOT, "project.config.json")))) {
    await cp(path.join(REPO_ROOT, "project.config.json"), path.join(GENERATED_ROOT, "project.config.json"));
  }

  await mkdir(GENERATED_MINIAPP, { recursive: true });
  await cp(MINIAPP_SOURCE, GENERATED_MINIAPP, { recursive: true, force: true });

  const projectPath = path.join(GENERATED_ROOT, "project.config.json");
  const projectConfig = JSON.parse(await readFile(path.join(REPO_ROOT, "project.config.json"), "utf8"));
  projectConfig.projectname = `${projectConfig.projectname || "TiGame-WeChat"}-Local`;
  projectConfig.setting ||= {};
  projectConfig.setting.urlCheck = false;
  await writeFile(projectPath, `${JSON.stringify(projectConfig, null, 2)}\n`, "utf8");

  const configPath = path.join(GENERATED_MINIAPP, "config.js");
  const configSource = await readFile(configPath, "utf8");
  const patched = configSource.replace(/API_BASE:\s*['"][^'"]+['"]/, `API_BASE: '${apiBase}'`);
  if (patched === configSource) throw new Error("Unable to patch generated Mini Program API_BASE.");
  await writeFile(configPath, patched, "utf8");
}

async function runOpenScript(checkOnly = false) {
  const args = [OPEN_SCRIPT, "--project", GENERATED_ROOT];
  if (checkOnly) args.push("--check");
  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    windowsHide: false,
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode ?? 1));
  });
  if (code !== 0) throw new Error(`Mini Program launcher exited with code ${code}.`);
}

function startSourceWatcher(apiBase) {
  let timer = null;
  const watcher = watch(MINIAPP_SOURCE, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      syncGeneratedProject(apiBase)
        .then(() => console.log("Synced Mini Program source to local DevTools project."))
        .catch((error) => console.warn(`Unable to sync Mini Program source: ${error.message}`));
    }, 150);
  });
  return watcher;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (options.check) {
    await syncGeneratedProject(LOOPBACK_BASE);
    await runOpenScript(true);
    console.log(`Generated local Mini Program project: ${GENERATED_ROOT}`);
    return;
  }

  if (process.platform !== "win32") {
    throw new Error("dev:miniprogram:local must be run on your Windows development machine.");
  }

  let server = null;
  let ownsServer = false;
  let watcher = null;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    watcher?.close();
    if (ownsServer && server) terminateProcessTree(server.pid);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    if (await isTiGameHealthy(LOOPBACK_BASE)) {
      console.log(`Reusing TiGame local server at ${LOOPBACK_BASE}.`);
    } else {
      console.log(`Starting TiGame local server on 0.0.0.0:${LOCAL_PORT}...`);
      server = cmdSpawn(`pnpm dev --port ${LOCAL_PORT} --strictPort`, { stdio: "inherit" });
      ownsServer = true;
      await waitForLocalServer(server);
    }

    const candidates = lanCandidates(options.ip);
    if (candidates.length === 0) {
      throw new Error("No private LAN IPv4 address detected. Connect to LAN/Wi-Fi or pass --ip <IPv4>.");
    }

    const lan = await findReachableLanCandidate(candidates);
    if (!lan) {
      throw new Error(
        `TiGame is healthy on ${LOOPBACK_BASE} but not reachable through a private LAN address. ` +
        "Check Windows Firewall/private-network access or retry with --ip <PC-LAN-IP>.",
      );
    }

    const apiBase = `http://${lan.address}:${LOCAL_PORT}`;
    await syncGeneratedProject(apiBase);
    console.log(`\nLocal Mini Program API: ${apiBase}`);
    console.log(`Detected LAN interface: ${lan.name}`);
    console.log("DevTools URL/domain validation: off for generated local project");
    console.log(`Generated project: ${GENERATED_ROOT}`);
    if (options.noOpen) {
      console.log("WeChat DevTools auto-open: disabled\n");
    } else {
      console.log("Opening WeChat DevTools...\n");
      await runOpenScript(false);
    }

    watcher = startSourceWatcher(apiBase);
    console.log(options.noOpen ? "Ready for local Mini Program build/watch." : "Ready for local Mini Program debugging.");
    console.log(`- API/WebSocket: ${apiBase}`);
    console.log("- Source changes under miniprogram/ are mirrored into the generated project");
    console.log("- Keep phone and PC on the same LAN/Wi-Fi for true-device debugging");
    console.log("- Press Ctrl+C here to stop the local session\n");

    await new Promise((resolve, reject) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
      if (server) {
        server.once("exit", (code) => {
          if (!stopping) reject(new Error(`Local TiGame server exited unexpectedly (code ${code ?? 0}).`));
          else resolve();
        });
      }
    });
  } finally {
    stop();
  }
}

main().catch((error) => {
  console.error(`\n[miniapp-local] ${error.message}`);
  process.exitCode = 1;
});
