#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const CLI_ENV_NAME = "WECHAT_DEVTOOLS_CLI_PATH";

function printHelp() {
  console.log(`Usage: pnpm dev:miniprogram [options]\n\nOptions:\n  --check              Validate the Mini Program project without opening DevTools\n  --project <path>     Open a generated Mini Program project instead of the repository root\n  --help               Show this help\n\nWindows launch requires the ${CLI_ENV_NAME} environment variable to point to WeChat DevTools cli.bat.`);
}

function parseArgs(argv) {
  const options = { check: false, help: false, projectRoot: REPO_ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--check") options.check = true;
    else if (arg === "--project") {
      const value = argv[++index] || "";
      if (!value) throw new Error("--project requires a project directory.");
      options.projectRoot = path.resolve(value);
    } else throw new Error(`Unknown option: ${arg}`);
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

async function validateProject(projectRoot) {
  const projectConfig = path.join(projectRoot, "project.config.json");
  const privateProjectConfig = path.join(projectRoot, "project.private.config.json");
  if (!(await exists(projectConfig))) throw new Error(`Missing ${projectConfig}`);

  const config = JSON.parse(await readFile(projectConfig, "utf8"));
  const root = config.miniprogramRoot || "miniprogram/";
  const miniappRoot = path.resolve(projectRoot, root);
  const appConfig = path.join(miniappRoot, "app.json");
  if (!(await exists(appConfig))) throw new Error(`Missing ${appConfig}`);

  const privateConfig = (await exists(privateProjectConfig))
    ? JSON.parse(await readFile(privateProjectConfig, "utf8"))
    : {};
  if (config.compileType !== "miniprogram") {
    throw new Error("project.config.json compileType must be miniprogram.");
  }
  if (typeof config.projectname !== "string" || !config.projectname.trim()) {
    throw new Error("project.config.json projectname is required by WeChat DevTools CLI.");
  }

  const privateAppId = typeof privateConfig.appid === "string" ? privateConfig.appid.trim() : "";
  const publicAppId = typeof config.appid === "string" ? config.appid.trim() : "";
  return {
    appId: privateAppId || publicAppId,
    appIdSource: privateAppId ? "project.private.config.json" : "project.config.json",
    projectName: config.projectname,
  };
}

async function openDevTools(cliPath, projectRoot) {
  const comSpec = process.env.ComSpec || "cmd.exe";
  const command = `call "${cliPath}" open --project "${projectRoot}"`;
  const child = spawn(comSpec, ["/d", "/s", "/c", command], {
    cwd: projectRoot,
    stdio: "inherit",
    windowsHide: false,
    windowsVerbatimArguments: true,
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

  const projectRoot = options.projectRoot;
  const project = await validateProject(projectRoot);
  console.log(`Mini Program project: ${projectRoot}`);
  console.log(`Project name: ${project.projectName}`);
  if (project.appId) console.log(`AppID: ${project.appId} (${project.appIdSource})`);
  else {
    console.warn(
      "AppID: <empty> — basic local editing can be prepared, but preview/real-device and some APIs require a test or real AppID.",
    );
  }

  if (options.check) {
    console.log("Project structure check passed.");
    return;
  }

  if (!project.appId) {
    throw new Error(
      "No AppID is configured in project.private.config.json or project.config.json. " +
      "WeChat DevTools CLI requires an AppID to open a specific project. Use a test or real AppID for GUI debugging, " +
      "or run pnpm dev:miniprogram:check for static validation.",
    );
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
  await openDevTools(cliPath, projectRoot);
  console.log("WeChat DevTools project opened.");
}

main().catch((error) => {
  console.error(`\n[wechat-devtools] ${error.message}`);
  process.exitCode = 1;
});
