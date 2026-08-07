#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const PROJECT_CONFIG = path.join(REPO_ROOT, "project.config.json");
const MINIAPP_ROOT = path.join(REPO_ROOT, "miniprogram");
const APP_CONFIG = path.join(MINIAPP_ROOT, "app.json");
const USER_CONFIG_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), ".tigame"), "TiGame");
const USER_CONFIG_PATH = path.join(USER_CONFIG_DIR, "wechat-devtools.json");

function printHelp() {
  console.log(`Usage: pnpm dev:miniprogram [options]\n\nOptions:\n  --cli <path>   Override WeChat DevTools cli.bat path\n  --check        Validate the Mini Program project without opening DevTools\n  --reset        Forget the locally saved DevTools path\n  --help         Show this help\n\nLocal DevTools settings are saved outside the repository at:\n  ${USER_CONFIG_PATH}`);
}

function parseArgs(argv) {
  const options = { cliPath: "", check: false, reset: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--check") options.check = true;
    else if (arg === "--reset") options.reset = true;
    else if (arg === "--cli") options.cliPath = argv[++index] || "";
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadUserConfig() {
  if (!(await exists(USER_CONFIG_PATH))) return {};
  try {
    return JSON.parse(await readFile(USER_CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function saveUserConfig(config) {
  await mkdir(USER_CONFIG_DIR, { recursive: true });
  await writeFile(USER_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function promptValue(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`${question} (non-interactive shell)`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

function commonWindowsCliCandidates() {
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean);
  const suffixes = [
    ["Tencent", "微信开发者工具", "cli.bat"],
    ["Tencent", "微信web开发者工具", "cli.bat"],
  ];
  const candidates = [];
  for (const root of roots) {
    for (const suffix of suffixes) candidates.push(path.join(root, ...suffix));
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    candidates.push(path.join(localAppData, "Programs", "微信开发者工具", "cli.bat"));
    candidates.push(path.join(localAppData, "Programs", "Tencent", "微信开发者工具", "cli.bat"));
    candidates.push(path.join(localAppData, "Tencent", "微信开发者工具", "cli.bat"));
  }
  return candidates;
}

async function resolveCliPath(options, userConfig) {
  const candidates = [
    options.cliPath,
    process.env.WECHAT_DEVTOOLS_CLI_PATH,
    userConfig.devtoolsCliPath,
    ...commonWindowsCliCandidates(),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const absolute = path.resolve(candidate.replace(/^"|"$/g, ""));
    if (await exists(absolute)) return absolute;
  }

  const entered = await promptValue("Path to WeChat DevTools cli.bat: ");
  const absolute = path.resolve(entered.replace(/^"|"$/g, ""));
  if (!(await exists(absolute))) throw new Error(`WeChat DevTools CLI not found: ${absolute}`);
  userConfig.devtoolsCliPath = absolute;
  await saveUserConfig(userConfig);
  console.log(`Saved DevTools CLI path locally: ${USER_CONFIG_PATH}`);
  return absolute;
}

async function validateProject() {
  if (!(await exists(PROJECT_CONFIG))) throw new Error(`Missing ${PROJECT_CONFIG}`);
  if (!(await exists(APP_CONFIG))) throw new Error(`Missing ${APP_CONFIG}`);
  const config = JSON.parse(await readFile(PROJECT_CONFIG, "utf8"));
  if (config.compileType !== "miniprogram") throw new Error("project.config.json compileType must be miniprogram.");
  if (typeof config.projectname !== "string" || !config.projectname.trim()) {
    throw new Error("project.config.json projectname is required by WeChat DevTools CLI.");
  }
  const root = config.miniprogramRoot || "miniprogram/";
  if (path.resolve(REPO_ROOT, root) !== MINIAPP_ROOT) {
    throw new Error(`Unexpected miniprogramRoot: ${root}`);
  }
  const appId = typeof config.appid === "string" ? config.appid.trim() : "";
  return { appId, projectName: config.projectname };
}

async function openDevTools(cliPath) {
  const comSpec = process.env.ComSpec || "cmd.exe";
  const command = `call "${cliPath}" -o "${REPO_ROOT}"`;
  const child = spawn(comSpec, ["/d", "/s", "/c", command], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    windowsHide: false,
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode ?? 1));
  });
  if (code !== 0) throw new Error(`WeChat DevTools CLI exited with code ${code}.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.reset) await rm(USER_CONFIG_PATH, { force: true });
  const project = await validateProject();
  console.log(`Mini Program project: ${REPO_ROOT}`);
  console.log(`Project name: ${project.projectName}`);
  if (project.appId) console.log(`AppID: ${project.appId}`);
  else console.warn("AppID: <empty> — basic local editing can be prepared, but preview/real-device and some APIs require a test or real AppID.");

  if (options.check) {
    console.log("Project structure check passed.");
    if (process.platform !== "win32") {
      console.log("DevTools launch check skipped: current environment is not Windows.");
    }
    return;
  }

  if (process.platform !== "win32") {
    throw new Error(
      "WeChat DevTools is installed on the Windows host, but this command is running inside the Linux Docker container. " +
      "The container has no host-GUI command bridge. Run `pnpm dev:miniprogram` from a Windows checkout to auto-open DevTools, " +
      "or use `pnpm dev:miniprogram:check` here for project validation.",
    );
  }

  const userConfig = options.reset ? {} : await loadUserConfig();
  const cliPath = await resolveCliPath(options, userConfig);
  console.log(`WeChat DevTools CLI: ${cliPath}`);
  console.log("Opening WeChat DevTools...");
  await openDevTools(cliPath);
  console.log("WeChat DevTools project opened.");
}

main().catch((error) => {
  console.error(`\n[wechat-devtools] ${error.message}`);
  process.exitCode = 1;
});
