import type { OffscreenMessage } from '../../utils/messages'
import { getBookInfo, getCatalog, getChapterContent, searchBooks } from '../../utils/scraper'

// MV3 service worker 没有 DOM，所有 DOMParser 相关工作放在 offscreen document 中。
// 这里只处理 background 转发过来的请求（带 relay 标记）：
// runtime.sendMessage 是广播，侧边栏的原始消息也会落到这里，若不拦掉就会重复抓一遍。
browser.runtime.onMessage.addListener((message: OffscreenMessage) => {
  if (!message || message.relay !== true) return
  switch (message.type) {
    case 'search':
      return searchBooks(message.source, message.keyword)
    case 'getCatalog':
      return getCatalog(message.source, message.detailUrl)
    case 'getChapterContent':
      return getChapterContent(message.source, message.chapterUrl)
    case 'getBookInfo':
      return getBookInfo(message.source, message.detailUrl)
  }
})
