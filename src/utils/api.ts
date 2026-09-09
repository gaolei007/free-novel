import type { BookSource } from '../types/source'
import type { BookItem, ChapterItem } from './messages'

/**
 * sidepanel 调用 background 执行跨域抓取。
 * 扩展页面直接 fetch 任意网站会被 CORS 拦截，
 * 而 background 拥有 <all_urls> 权限，必须走消息中转。
 */
export function searchBooks(keyword: string, source: BookSource): Promise<BookItem[]> {
  return browser.runtime.sendMessage({ type: 'search', keyword, source })
}

export function getCatalog(detailUrl: string, source: BookSource): Promise<ChapterItem[]> {
  return browser.runtime.sendMessage({ type: 'getCatalog', detailUrl, source })
}

export function getChapterContent(chapterUrl: string, source: BookSource): Promise<string> {
  return browser.runtime.sendMessage({ type: 'getChapterContent', chapterUrl, source })
}
