import { normalizeSources } from './sourceConvert'
import { loadSources, saveSources } from './storage'
import { assertSafeHttpUrl } from './urlSafety'

export const SO_NOVEL_SOURCES_URL = 'https://raw.githubusercontent.com/freeok/so-novel/refs/heads/main/bundle/rules/main.json'

export interface SyncResult { added: number; updated: number; total: number }

export async function syncSoNovelSources(): Promise<SyncResult> {
  assertSafeHttpUrl(SO_NOVEL_SOURCES_URL, '书源同步地址')
  const response = await fetch(SO_NOVEL_SOURCES_URL, { cache: 'no-store' })
  if (!response.ok) throw new Error(`远程书源请求失败（HTTP ${response.status}）`)
  const incoming = normalizeSources(await response.json())
  if (!incoming.length) throw new Error('远程文件中没有可识别的 so-novel 书源')

  const merged = new Map((await loadSources()).map((source) => [source.url, source]))
  let added = 0
  let updated = 0
  for (const source of incoming) {
    const previous = merged.get(source.url)
    merged.set(source.url, previous ? { ...source, enabled: previous.enabled } : source)
    previous ? updated++ : added++
  }
  const sources = [...merged.values()]
  await saveSources(sources)
  return { added, updated, total: sources.length }
}
