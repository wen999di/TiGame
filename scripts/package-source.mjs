import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 用 Git 已跟踪文件生成干净源码包（P0-01）：
 * 绝不包含 .wrangler/node_modules/.vinext/dist/日志等运行时状态。
 */
const root = resolve(import.meta.dirname, "..");
const outDir = resolve(root, "outputs");
mkdirSync(outDir, { recursive: true });
const out = resolve(outDir, `TiGame-source-${Date.now()}.zip`);
execFileSync("git", ["archive", "--format=zip", "--output", out, "HEAD"], {
  cwd: root,
  stdio: "inherit",
});
console.log(`source package created: ${out}`);