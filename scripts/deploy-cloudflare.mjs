import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = resolve(import.meta.dirname, "..");
const run = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH: "./wrangler.jsonc",
    },
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const wranglerCommand = process.platform === "win32"
  ? resolve(projectRoot, "node_modules/.bin/wrangler.cmd")
  : resolve(projectRoot, "node_modules/.bin/wrangler");

run(npmCommand, ["run", "build:cloudflare"]);
run(wranglerCommand, ["deploy"]);