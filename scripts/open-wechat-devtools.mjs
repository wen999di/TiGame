#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const PROJECT_CONFIG = path.join(REPO_ROOT, "project.config.json");
const MINIAPP_ROOT = path.join(REPO_ROOT, "miniprogram");
const APP_CONFIG = path.join(MINIAPP_ROOT, "app.json");
const CLI_ENV_NAME = "WECHAT_DEVTOOLS_CLI_PATH";

function printHelp() {
  console.log(`Usage: pnpm dev:miniprogram [options]\n\nOptions:\n  --check   Validate the Mini Program project without opening DevTools\n  --help    Show this help\n\nWindows launch requires the ${CLI_ENV_NAME} environment variable to point to WeChat DevTools cli.bat.`);
}

function parseArgs(argv) {
  const options = { check: false, help: false };
  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--check") options.check = true;
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

async function resolveCliPathFromEnv() {
  const configured = process.env[CLI_ENV_NAME]?.trim();
  if (!configured) {
    throw new Error(
      `${CLI_ENV_NAME} is not set. Set it to the full path of WeChat DevTools cli.bat before running pnpm dev:miniprogram.`,
    );
  }

  const cliPath = path.resolve(configured.replace(/^"|"$/g, ""));
  if (!(await exists(cliPath))) {
    throw new Error(`${CLI_ENV_NAME} points to a file that does not exist: ${cliPath}`);
  }
  if (path.basename(cliPath).toLowerCase() !== "cli.bat") {
    throw new Error(`${CLI_ENV_NAME} must point to WeChat DevTools cli.bat: ${cliPath}`);
  }
  return cliPath;
}

async function validateProject() {
  if (!(await exists(PROJECT_CONFIG))) throw new Error(`Missing ${PROJECT_CONFIG}`);
  if (!(await exists(APP_CONFIG))) throw new Error(`Missing ${APP_CONFIG}`);

  const config = JSON.parse(await readFile(PROJECT_CONFIG, "utf8"));
  if (config.compileType !== "miniprogram") {
    throw new Error("project.config.json compileType must be miniprogram.");
  }
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
  if (code !== 0) {
    throw new Error(`WeChat DevTools CLI exited with code ${code}.`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const project = await validateProject();
  console.log(`Mini Program project: ${REPO_ROOT}`);
  console.log(`Project name: ${project.projectName}`);
  if (project.appId) console.log(`AppID: ${project.appId}`);
  else {
    console.warn(
      "AppID: <empty> — basic local editing can be prepared, but preview/real-device and some APIs require a test or real AppID.",
    );
  }

  if (options.check) {
    console.log("Project structure check passed.");
    return;
  }

  if (process.platform !== "win32") {
    throw new Error(
      "WeChat DevTools is installed on the Windows host, but this command is running inside the Linux Docker container. " +
      "Run pnpm dev:miniprogram from a Windows checkout, or use pnpm dev:miniprogram:check here for project validation.",
    );
  }

  const cliPath = await resolveCliPathFromEnv();
  console.log(`WeChat DevTools CLI: ${cliPath}`);
  console.log("Opening WeChat DevTools...");
  await openDevTools(cliPath);
  console.log("WeChat DevTools project opened.");
}

main().catch((error) => {
  console.error(`\n[wechat-devtools] ${error.message}`);
  process.exitCode = 1;
});
