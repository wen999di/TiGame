import path from "node:path";
import { defineConfig } from "@tarojs/cli";

const MINIAPP_ROOT = path.resolve(__dirname, "..");
const outputRoot = process.env.TIGAME_MINIAPP_OUTPUT_ROOT || "../dist/miniapp";
const apiBase = process.env.TIGAME_MINIAPP_API_BASE || "https://tigame.cavendish.dpdns.org";

export default defineConfig({
  projectName: "TiGame",
  date: "2026-08-09",
  designWidth: 750,
  sourceRoot: "src",
  outputRoot,
  framework: "react",
  compiler: "webpack5",
  compile: { include: [path.resolve(MINIAPP_ROOT, "../app")] },
  plugins: ["@tarojs/plugin-html"],
  defineConstants: {
    __TIGAME_API_BASE__: JSON.stringify(apiBase),
    __TIGAME_MINIAPP_DEBUG__: JSON.stringify(process.env.TIGAME_MINIAPP_DEBUG === "1"),
  },
  alias: {
    react: path.resolve(MINIAPP_ROOT, "node_modules/react"),
    qrcode: path.resolve(MINIAPP_ROOT, "src/shims/qrcode.ts"),
    jsqr: path.resolve(MINIAPP_ROOT, "src/shims/jsqr.ts"),
    "motion/react": path.resolve(MINIAPP_ROOT, "src/shims/motion.tsx"),
    "@tigame/portal": path.resolve(MINIAPP_ROOT, "src/shims/react-dom.tsx"),
    "@tigame/form-controls": path.resolve(MINIAPP_ROOT, "src/shims/form-controls.tsx"),
    "@tigame/mahjong-history": path.resolve(MINIAPP_ROOT, "src/shims/MahjongHistory.tsx"),
    "@tigame/mahjong-send-trace": path.resolve(MINIAPP_ROOT, "src/shims/MahjongSendTrace.tsx"),
  },
  copy: {
    patterns: [
      { from: "../public/favicon.png", to: `${outputRoot}/favicon.png` },
      { from: "assets/logo.png", to: `${outputRoot}/logo.png` },
      { from: "src/sitemap.json", to: `${outputRoot}/sitemap.json` },
    ],
    options: {},
  },
  mini: {
    webpackChain(chain) {
      chain.module
        .rule("shared-react")
        .test(/\.m?[tj]sx?$/i)
        .include.add(path.resolve(MINIAPP_ROOT, "../app"))
        .end()
        .use("babel-loader")
        .loader(require.resolve("babel-loader"))
        .options({ configFile: path.resolve(MINIAPP_ROOT, "babel.config.js") });
    },
    postcss: {
      pxtransform: { enable: false },
      url: { enable: true, config: { limit: 8192 } },
      cssModules: { enable: false },
    },
  },
});
