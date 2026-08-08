#!/usr/bin/env node

import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const MINIAPP_SOURCE = path.join(REPO_ROOT, "miniprogram");
const PROJECT_CONFIG = path.join(REPO_ROOT, "project.config.json");
const OPEN_SCRIPT = path.join(SCRIPT_DIR, "open-wechat-devtools.mjs");

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if ((code ?? 1) === 0) resolve();
      else reject(new Error(`node ${args.join(" ")} exited with code ${code ?? 1}.`));
    });
  });
}
async function listJavaScriptFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

async function validateBuild() {
  await runNode([OPEN_SCRIPT, "--check"]);
  const files = await listJavaScriptFiles(MINIAPP_SOURCE);
  for (const file of files) {
    await runNode(["--check", file]);
  }
  const time = new Date().toLocaleTimeString();
  console.log(`[miniapp-build] Build check passed at ${time}. Watching for changes...`);
}

async function main() {
  let timer = null;
  let running = false;
  let rerun = false;
  let stopping = false;

  const rebuild = async () => {
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      await validateBuild();
    } catch (error) {
      console.error(`\n[miniapp-build] ${error.message}`);
    } finally {
      running = false;
      if (rerun && !stopping) {
        rerun = false;
        void rebuild();
      }
    }
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void rebuild(), 120);
  };

  await validateBuild();
  console.log("[miniapp-build] Native Mini Program source is build-ready; no DevTools window will be opened.");

  const sourceWatcher = watch(MINIAPP_SOURCE, { recursive: true }, schedule);
  const configWatcher = watch(PROJECT_CONFIG, schedule);

  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    sourceWatcher.close();
    configWatcher.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

main().catch((error) => {
  console.error(`\n[miniapp-build] ${error.message}`);
  process.exitCode = 1;
});
