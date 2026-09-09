import type { BackgroundMessage } from '../../utils/messages'
import { getCatalog, getChapterContent, searchBooks } from '../../utils/scraper'

// MV3 service worker 没有 DOM，所有 DOMParser 相关工作放在 offscreen document 中。
browser.runtime.onMessage.addListener((message: BackgroundMessage) => {
  switch (message.type) {
    case 'search':
      return searchBooks(message.source, message.keyword)
    case 'getCatalog':
      return getCatalog(message.source, message.detailUrl)
    case 'getChapterContent':
      return getChapterContent(message.source, message.chapterUrl)
  }
})
