import { defineConfig } from "@tarojs/cli";

const outputRoot = process.env.TIGAME_MINIAPP_OUTPUT_ROOT || "../dist/miniapp";
const webBase = process.env.TIGAME_MINIAPP_WEB_BASE || "https://tigame.cavendish.dpdns.org";

export default defineConfig({
  projectName: "TiGame",
  date: "2026-08-09",
  designWidth: 750,
  sourceRoot: "src",
  outputRoot,
  framework: "react",
  compiler: "webpack5",
  defineConstants: {
    __TIGAME_WEB_BASE__: JSON.stringify(webBase),
  },
  copy: {
    patterns: [{ from: "src/sitemap.json", to: `${outputRoot}/sitemap.json` }],
    options: {},
  },
  mini: {
    postcss: {
      pxtransform: { enable: false },
      url: { enable: true, config: { limit: 8192 } },
      cssModules: { enable: false },
    },
  },
});
