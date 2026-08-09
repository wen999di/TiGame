export default defineAppConfig({
  pages: ["pages/index/index"],
  renderer: "webview",
  window: {
    navigationStyle: "custom",
    backgroundColor: "#0b1726",
    backgroundTextStyle: "light",
  },
  sitemapLocation: "sitemap.json",
});
