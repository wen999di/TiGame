import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = resolve(import.meta.dirname, "..");
const wranglerConfig = resolve(projectRoot, "wrangler.jsonc");

try {
  await access(wranglerConfig);
} catch {
  console.error("Missing wrangler.jsonc. Create the Cloudflare deployment config first.");
  process.exit(64);
}

const vinextCommand = process.platform === "win32"
  ? resolve(projectRoot, "node_modules/.bin/vinext.cmd")
  : resolve(projectRoot, "node_modules/.bin/vinext");

const result = spawnSync(vinextCommand, ["build"], {
  cwd: projectRoot,
  env: {
    ...process.env,
    CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH: "./wrangler.jsonc",
  },
  stdio: "inherit",
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);