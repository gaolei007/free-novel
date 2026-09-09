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

/** sidepanel → background 的消息（抓取在 background 做，规避 CORS） */
export type BackgroundMessage =
  | { type: 'search'; keyword: string; source: BookSource }
  | { type: 'getCatalog'; detailUrl: string; source: BookSource }
  | { type: 'getChapterContent'; chapterUrl: string; source: BookSource }
