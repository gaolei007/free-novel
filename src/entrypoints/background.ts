import type { BackgroundMessage } from '../utils/messages'

async function ensureOffscreenDocument() {
  const extensionRoot = browser.runtime.getURL('/sidepanel.html').replace(/sidepanel\.html$/, '')
  const url = `${extensionRoot}offscreen.html`
  const contexts = await browser.runtime.getContexts({
    contextTypes: [browser.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [url],
  })
  if (contexts.length) return

  await browser.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: [browser.offscreen.Reason.DOM_PARSER],
    justification: '解析小说书源返回的 HTML 页面',
  })
}

async function runScraper(message: BackgroundMessage) {
  await ensureOffscreenDocument()
  return browser.runtime.sendMessage(message)
}

export default defineBackground(() => {
  console.log('Hello background!', { id: browser.runtime.id })

  // 点击扩展图标打开侧边栏（必须在用户手势回调中调用）
  browser.action.onClicked.addListener((tab) => {
    if (tab.windowId != null) {
      browser.sidePanel.open({ windowId: tab.windowId })
    }
  })

  // 消息路由：处理侧边栏的抓取请求
  browser.runtime.onMessage.addListener((message: BackgroundMessage) => {
    switch (message.type) {
      case 'search':
        return runScraper(message)
      case 'getCatalog':
        return runScraper(message)
      case 'getChapterContent':
        return runScraper(message)
    }
  })
})
