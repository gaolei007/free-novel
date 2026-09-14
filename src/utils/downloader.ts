import type { BookSource } from '../types/source'
import type { ChapterItem } from './messages'
import { getChapterContent } from './api'
import { describeError } from './errors'

/**
 * 单章请求的看门狗：覆盖 sidepanel → background → offscreen 整条消息链路。
 * 任何一环卡死（如 service worker 重启时丢消息）都不会拖住整个下载，
 * 超时后由上层重试。fetch 自身有 15s 超时，这里主要兜消息链路。
 */
const CHAPTER_TIMEOUT = 60_000

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}请求超时（${Math.round(ms / 1000)}s）`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** 抓单章正文，失败按 1s/2s 退避重试，全部失败抛出最后一次错误 */
async function fetchChapter(chapter: ChapterItem, source: BookSource, retries: number): Promise<string> {
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await withTimeout(getChapterContent(chapter.url, source), CHAPTER_TIMEOUT, `「${chapter.name}」`)
    } catch (error) {
      lastError = error
      if (attempt < retries) await sleep(1000 * 2 ** attempt)
    }
  }
  throw lastError
}

export interface DownloadOptions {
  /** 并发请求数，默认 4。站点普遍限流，不宜开太大 */
  concurrency?: number
  /** 单章重试次数，默认 2 */
  retries?: number
  onProgress?: (completed: number, total: number, failedChapters: string[]) => void
  /**
   * 每章结束时回调（成功给正文，失败给空串）。
   * 用于增量落盘，下载中断后已抓到的章节不会白费。
   */
  onChapter?: (index: number, content: string) => void
}

/** 单章失败的明细，供记录页展示失败原因、补章时定位章节 */
export interface FailedChapterInfo {
  /** 章节在传入 chapters 数组中的下标 */
  index: number
  name: string
  url: string
  reason: string
}

export interface DownloadResult {
  /** 与 chapters 同序的正文数组，失败的章节为空串 */
  contents: string[]
  failedChapters: string[]
  /** 与 failedChapters 对应的明细（名称 + 地址 + 失败原因） */
  failedDetails: FailedChapterInfo[]
}

/**
 * 并发抓取全部章节，保持原有顺序。
 * 单章重试耗尽后跳过并记入 failedChapters / failedDetails，不影响其余章节。
 */
export async function downloadChapters(
  chapters: ChapterItem[],
  source: BookSource,
  options: DownloadOptions = {},
): Promise<DownloadResult> {
  const { concurrency = 4, retries = 2, onProgress, onChapter } = options
  const contents = new Array<string>(chapters.length).fill('')
  const failedChapters: string[] = []
  const failedDetails: FailedChapterInfo[] = []
  let cursor = 0
  let completed = 0

  const worker = async () => {
    while (cursor < chapters.length) {
      const index = cursor
      cursor += 1
      const chapter = chapters[index]
      if (!chapter) break
      try {
        contents[index] = await fetchChapter(chapter, source, retries)
      } catch (error) {
        failedChapters.push(chapter.name)
        failedDetails.push({
          index,
          name: chapter.name,
          url: chapter.url,
          reason: describeError(error) || '未知错误',
        })
      }
      completed += 1
      onChapter?.(index, contents[index] ?? '')
      onProgress?.(completed, chapters.length, [...failedChapters])
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, chapters.length) }, () => worker()))
  return { contents, failedChapters, failedDetails }
}
