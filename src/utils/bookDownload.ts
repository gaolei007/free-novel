import type { BookSource } from '../types/source'
import type { ChapterItem } from './messages'
import { loadRecords, type DownloadRecord } from './storage'
import { downloadChapters, type FailedChapterInfo } from './downloader'
import { loadChapters, pruneChapters, saveChapters, type ChapterInput } from './chapterStore'

/** 正文缓存最多保留多少条记录的，超出后从最旧的开始清（不设上限会一直涨） */
const CACHE_KEEP_RECORDS = 20

export function removeDuplicateChapterHeading(content: string, chapterName: string): string {
  const lines = content.split('\n')
  const first = lines[0]?.replace(/[\s：:]/g, '')
  const chapter = chapterName.replace(/[\s：:]/g, '')
  return first === chapter ? lines.slice(1).join('\n').trim() : content.trim()
}

export function safeFileName(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 100)
  return `${safe || '小说'}.txt`
}

/** 拼出整本 txt，格式与原下载逻辑保持一致；正文为空的章节（失败未补上）直接跳过 */
export function buildBookText(
  bookName: string,
  author: string,
  chapters: { name: string; content: string }[],
): string {
  const parts = [`${bookName}\n作者：${author || '未知'}\n`]
  for (const chapter of chapters) {
    if (!chapter.content) continue
    parts.push(`\n${chapter.name}\n${removeDuplicateChapterHeading(chapter.content, chapter.name)}\n`)
  }
  return parts.join('\n')
}

/** 触发浏览器下载。补章是同一本书的完整版，覆盖同名文件 */
export function triggerTextDownload(fileName: string, text: string): Promise<number> {
  const url = `data:text/plain;charset=utf-8,${encodeURIComponent(`\uFEFF${text}`)}`
  return browser.downloads.download({
    url,
    filename: fileName,
    saveAs: false,
    conflictAction: 'overwrite',
  })
}

/**
 * 识别「章节串台」：书源的翻页规则一旦跟丢，会把后面几十章抓进同一章，
 * 表现就是整本大量重复行（正常小说文本唯一行占比 90%+，串台后会掉到 10% 以内）。
 * 命中时宁可报错，也不产出一个几百 MB 的垃圾文件。
 */
export function looksLikeDuplicatedContent(contents: string[]): boolean {
  const lines: string[] = []
  for (const content of contents) {
    if (!content) continue
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length >= 10) lines.push(trimmed)
    }
  }
  if (lines.length < 200) return false
  return new Set(lines).size / lines.length < 0.5
}

/** 只保留最近若干条记录的正文缓存 */
async function pruneCache(): Promise<void> {
  try {
    const records = await loadRecords()
    await pruneChapters(records.slice(0, CACHE_KEEP_RECORDS).map((record) => record.id))
  } catch {
    // 缓存清理失败不影响下载结果
  }
}

export interface FetchBookResult {
  contents: string[]
  failedChapters: string[]
  failedDetails: FailedChapterInfo[]
}

/** 增量写缓存的节流间隔，太频繁会拖慢抓取 */
const FLUSH_INTERVAL = 2000

/**
 * 抓完整本正文并写入本地缓存。
 * 缓存是「补章 / 续传」的前提：先落一份整本骨架（章名 + 地址、正文为空），
 * 之后边下边写，这样中途被打断也能从已抓到的部分接着下。
 */
export async function fetchAndCacheBook(
  source: BookSource,
  recordId: string,
  chapters: ChapterItem[],
  onProgress: (completed: number, total: number, failedChapters: string[]) => void,
): Promise<FetchBookResult> {
  const inputs: ChapterInput[] = chapters.map((chapter, index) => ({
    index,
    name: chapter.name,
    url: chapter.url,
    content: '',
  }))
  await saveChapters(recordId, inputs)

  let dirty = false
  let lastFlush = 0
  let flushing: Promise<void> = Promise.resolve()
  /** 节流写盘；串行化，避免两次写入交叠 */
  const flush = (force = false): Promise<void> => {
    if (!dirty) return flushing
    const now = Date.now()
    if (!force && now - lastFlush < FLUSH_INTERVAL) return flushing
    lastFlush = now
    dirty = false
    flushing = flushing.then(() => saveChapters(recordId, inputs)).catch(() => undefined)
    return flushing
  }

  const result = await downloadChapters(chapters, source, {
    concurrency: 4,
    onProgress,
    onChapter: (index, content) => {
      const entry = inputs[index]
      if (!entry) return
      entry.content = content
      dirty = true
      void flush()
    },
  })

  await flush(true)
  await pruneCache()
  return result
}

export interface ResumeResult {
  /** 本次补齐的章节数 */
  filled: number
  /** 补完仍然失败的章节 */
  stillFailed: FailedChapterInfo[]
  /** 重建后的文件下载 id */
  downloadId: number
  /** 全书已拿到正文的章节数 */
  contentCount: number
  /** 本次开始前缺失的章节数 */
  pending: number
}

/**
 * 续传 / 补章：以本地缓存为准，只重抓还没有正文的章节，
 * 合并后重建整本 txt 并覆盖同名文件。
 * 「下载中断后继续」和「补下失败章节」共用这一条路径——两者的差别只是缺的章多与少。
 */
export async function resumeDownload(options: {
  record: DownloadRecord
  source: BookSource
  onProgress?: (completed: number, total: number, failed: number) => void
}): Promise<ResumeResult> {
  const { record, source, onProgress } = options
  const cached = await loadChapters(record.id)
  if (!cached.length) throw new Error('本地缓存的正文已不存在，请重新下载整本')
  // 正常下载会先落整本骨架，条数对不上说明缓存被清过
  if (record.chapterCount && cached.length < record.chapterCount) {
    throw new Error('本地缓存不完整（可能已被清理），请重新下载整本')
  }

  const targets = cached.filter((chapter) => !chapter.content)
  if (!targets.length) throw new Error('没有待补的章节')

  const subset: ChapterItem[] = targets.map((chapter) => ({ name: chapter.name, url: chapter.url }))

  // 补章是收尾动作，并发压低、重试给足，尽量把这几章啃下来
  const { contents, failedDetails } = await downloadChapters(subset, source, {
    concurrency: 2,
    retries: 3,
    onProgress: (completed, total, failed) => onProgress?.(completed, total, failed.length),
  })

  let filled = 0
  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i]
    const content = contents[i]
    if (!target || !content) continue
    target.content = content
    filled += 1
  }
  if (!filled) throw new Error('待补章节重抓后仍全部失败，站点可能仍在限流')

  const contentCount = cached.filter((chapter) => chapter.content).length
  if (!contentCount) throw new Error('本地缓存的正文已不存在，请重新下载整本')

  await saveChapters(record.id, cached.map(({ index, name, url, content }) => ({ index, name, url, content })))

  const text = buildBookText(record.bookName, record.author, cached.map(({ name, content }) => ({ name, content })))
  if (looksLikeDuplicatedContent(cached.map((chapter) => chapter.content))) {
    throw new Error('章节内容疑似大量重复（书源翻页规则异常），已中止导出。请先同步书源，再重新下载整本')
  }
  const downloadId = await triggerTextDownload(record.fileName ?? safeFileName(record.bookName), text)

  // subset 的下标是子集下标，要映射回整本目录下标，记录页展示才不会错位
  const stillFailed: FailedChapterInfo[] = failedDetails.map((item) => ({
    ...item,
    index: targets[item.index]?.index ?? item.index,
  }))

  return { filled, stillFailed, downloadId, contentCount, pending: targets.length }
}
