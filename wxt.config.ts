import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  srcDir: 'src',
  webExt: {
    chromiumArgs: ['--user-data-dir=./.wxt/user-data'],
  },
  // 增加/修改 manifest 配置
  manifest: {
    // 你的插件名称
    name: '畅读小说',
    // 插件描述
    description: '基于 so-novel 书源搜索并下载小说',
    version: '1.0.0',
    // 权限申请（后续爬虫解析会用到）
    permissions: [
      'storage', 'sidePanel', 'offscreen', 'downloads',
    ],
    // 跨域请求权限（允许插件直接抓取任意小说的网页内容）
    host_permissions: [
      '<all_urls>',
    ],
    // 关键点 1：配置侧边栏入口文件
    side_panel: {
      default_path: 'sidepanel.html',
    },
    // 关键点 2：点击扩展图标时的动作（不配置 default_popup）
    action: {
      default_title: '打开畅读小说',
    },
  },
});
