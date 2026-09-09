# 畅读小说 Free Novel

Chrome Side Panel 小说搜索与 TXT 下载扩展。

基于 so-novel 书源，支持 Chrome Manifest V3、多书源并发搜索、整本小说下载、下载进度和本地下载记录。

## 功能

- 支持同步 so-novel 书源到本地，并进行增量合并
- 支持多个书源并发搜索书名和作者
- 搜索结果按书名、作者相关性排序，不合并不同书源的同名结果
- 搜索结果分页显示，每页 10 条
- 支持下载整本小说并合并为 UTF-8 编码的 TXT 文件
- 下载过程中显示章节进度，并保存下载记录
- 支持查看下载进度、打开下载文件位置和清空记录
- 使用 Chrome Side Panel API，跟随系统明暗主题

## 技术栈

- Chrome Manifest V3
- WXT
- Vue 3
- TypeScript
- Element Plus
- Chrome Side Panel API
- Chrome Downloads API

## 开发环境

- Google Chrome 109 或更高版本
- Node.js 22
- npm

## 安装依赖

```bash
npm install
```

## 本地开发

```bash
npm run dev
```

WXT 会启动开发环境并生成 Chrome 扩展目录。

## 构建扩展

```bash
npm run compile
npm run build
```

生产构建输出到：

```text
.output/chrome-mv3
```

生成可拖入 Chrome 扩展程序页面的压缩包：

```bash
npm run zip
```

压缩包输出到 `.output/free-novel-1.0.0-chrome.zip`。

## 在 Chrome 中加载

1. 打开 `chrome://extensions/`
2. 开启右上角“开发者模式”
3. 将打包生成的 `.output/free-novel-1.0.0-chrome.zip` 压缩包直接拖入扩展程序页面
4. 点击插件图标打开侧边栏
5. 首次使用时进入“同步书源”并点击“立即同步”

开发调试时，也可以点击“加载已解压的扩展程序”，选择 `.output/chrome-mv3` 目录。

## 书源

当前版本只支持 so-novel 书源，默认同步地址：

<https://raw.githubusercontent.com/freeok/so-novel/refs/heads/main/bundle/rules/main.json>

书源仅保存在浏览器本地 `storage` 中。搜索和下载记录不会上传到服务器。

## 权限说明

- `storage`：保存本地书源、下载记录和下载进度
- `sidePanel`：提供 Chrome 侧边栏界面
- `downloads`：下载合并后的 TXT 文件
- `offscreen`：在 Manifest V3 环境中解析网页 HTML
- `<all_urls>`：访问各个书源网站的搜索、目录和正文页面

插件只接受 HTTP(S) 书源地址，并拒绝带认证信息及常见本机/内网地址。书源规则中的脚本字段不会执行。

## 注意事项

书源网站的页面结构、访问限制和可用性可能随时变化。部分书源可能搜索失败或无法完整读取，插件会隐藏失败的搜索来源，并在下载记录中保存失败状态。

请遵守目标网站的使用条款和相关法律法规，仅下载你有权访问和保存的内容。

## 免责声明

畅读小说是一款用于网页内容解析、检索和格式转换的技术工具，仅供个人非商业性的学习、研究和技术交流使用。本项目不提供、不运营或推荐任何小说内容服务，书源规则来自公开项目，仅用于技术解析。

- 用户必须自行确认搜索、下载、保存和使用相关内容的合法性，并遵守适用的著作权、数据保护及其他法律法规。
- 严禁使用本工具抓取、下载、存储、传播未经授权的受版权保护内容，以及其他违法或侵犯他人合法权益的内容。
- 因用户使用本工具处理、保存、分发内容产生的法律责任、纠纷或损失，由用户自行承担。
- 由于网络、网站结构、访问限制、书源变化或法律法规调整导致的内容缺失、下载失败、数据丢失或其他问题，本项目及开发者不作任何明示或暗示的保证，也不承担相关责任。
- 使用本项目即表示你已阅读、理解并同意遵守本免责声明。
