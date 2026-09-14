import type { BookSource } from '../types/source'

/** 搜索结果单本书 */
export interface BookItem {
  name: string
  author: string
  latestChapter: string
  sourceName?: string
  sourceUrl?: string
  detailUrl: string
}

/** 目录单条章节 */
export interface ChapterItem {
  name: string
  url: string
}

/** 详情页里读到的书籍信息（供「按链接下载」用，绕开搜索） */
export interface BookInfo {
  name: string
  author: string
}

/** 抓取请求（抓取在 background 做，规避 CORS） */
export type ScrapeRequest =
  | { type: 'search'; keyword: string; source: BookSource }
  | { type: 'getCatalog'; detailUrl: string; source: BookSource }
  | { type: 'getChapterContent'; chapterUrl: string; source: BookSource }
  | { type: 'getBookInfo'; detailUrl: string; source: BookSource }

/** sidepanel → background；warmup 用于提前把离屏文档拉起来，避免首次搜索冷启动 */
export type BackgroundMessage = ScrapeRequest | { type: 'warmup' }

/**
 * background → offscreen。
 * runtime.sendMessage 是广播：侧边栏发出的请求会同时落到 background 和离屏文档，
 * 若两边都处理，同一次搜索/同一章会抓两遍（请求量翻倍、更容易被站点限流）。
 * 加 relay 标记后，离屏文档只处理 background 转发过来的消息。
 */
export type OffscreenMessage = ScrapeRequest & { relay: true }
