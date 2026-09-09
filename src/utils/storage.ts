import type { BookSource } from '../types/source'

export const STORAGE_KEYS = {
  sources: 'bookSources',
  records: 'downloadRecords',
} as const

export type DownloadStatus = 'downloading' | 'completed' | 'failed'

/** 一条下载记录 */
export interface DownloadRecord {
  id: string
  bookName: string
  author: string
  sourceName: string
  sourceUrl: string
  detailUrl: string
  chapterCount: number
  completedChapters: number
  progress: number
  status: DownloadStatus
  downloadedAt: number
  downloadId?: number
  fileName?: string
  errorMessage?: string
}

export async function loadSources(): Promise<BookSource[]> {
  const { [STORAGE_KEYS.sources]: sources } = await browser.storage.local.get(STORAGE_KEYS.sources)
  return (sources as BookSource[] | undefined) ?? []
}

export async function saveSources(sources: BookSource[]): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.sources]: sources })
}

export async function loadRecords(): Promise<DownloadRecord[]> {
  const { [STORAGE_KEYS.records]: records } = await browser.storage.local.get(STORAGE_KEYS.records)
  return (records as DownloadRecord[] | undefined) ?? []
}

/** 新记录置顶，最多保留 100 条 */
export async function addRecord(record: DownloadRecord): Promise<void> {
  const records = await loadRecords()
  await browser.storage.local.set({ [STORAGE_KEYS.records]: [record, ...records].slice(0, 100) })
}

/** 新增或更新下载记录，下载进度写入 storage 供记录页实时显示。 */
export async function upsertRecord(record: DownloadRecord): Promise<void> {
  const records = await loadRecords()
  const index = records.findIndex((item) => item.id === record.id)
  if (index >= 0) records[index] = record
  else records.unshift(record)
  await browser.storage.local.set({ [STORAGE_KEYS.records]: records.slice(0, 100) })
}

export async function clearRecords(): Promise<void> {
  await browser.storage.local.remove(STORAGE_KEYS.records)
}
