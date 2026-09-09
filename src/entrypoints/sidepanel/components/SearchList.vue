<template>
  <div class="search-list">
    <div class="search-bar">
      <el-input v-model="keyword" placeholder="输入书名或作者" clearable @keyup.enter="handleSearch">
        <template #append><el-button :loading="searching" @click="handleSearch"><el-icon><Search /></el-icon>搜索</el-button></template>
      </el-input>
    </div>

    <el-alert v-if="!enabledSources.length" title="暂无可搜索书源，请先同步 so-novel 书源" type="info" show-icon :closable="false" />
    <el-alert v-else-if="failedSources.length" :title="`${failedSources.length} 个书源搜索失败，已隐藏失败来源`" type="warning" show-icon :closable="false" />

    <div v-if="pagedBooks.length" class="result-section">
      <div class="result-heading"><span>搜索结果（{{ books.length }}）</span><span class="page-info">第 {{ currentPage }} / {{ pageCount }} 页</span></div>
      <div class="result-scroll">
        <div v-for="(book, index) in pagedBooks" :key="`${book.sourceName}-${book.detailUrl}-${index}`" class="book-item">
          <div class="book-main">
            <div class="book-title-row">
              <el-tag class="source-tag" size="small" effect="plain">{{ book.sourceName }}</el-tag>
              <div class="book-name">{{ book.name }}</div>
            </div>
            <div class="book-meta">作者：{{ book.author || '未知' }}</div>
            <div class="book-meta">最近章节：{{ book.latestChapter || '未知' }}</div>
          </div>
          <el-button
            class="download-button"
            size="small"
            type="primary"
            plain
            :loading="isDownloading(book)"
            :disabled="isDownloading(book)"
            @click="handleDownload(book)"
          >{{ isDownloading(book) ? '下载中' : '下载' }}</el-button>
        </div>
      </div>
      <el-pagination class="page-footer" v-model:current-page="currentPage" small layout="prev, pager, next" :page-size="pageSize" :total="books.length" />
    </div>
    <el-empty v-else-if="!searching" :description="hasSearched ? '没有找到匹配的小说' : '输入书名或作者开始搜索'" :image-size="64" />
    <div v-if="searching" class="loading-state"><el-icon class="is-loading"><Loading /></el-icon> 正在搜索{{ keyword }}···</div>
  </div>
</template>

<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Loading, Search } from '@element-plus/icons-vue'
import type { BookSource } from '../../../types/source'
import type { BookItem } from '../../../utils/messages'
import { getCatalog, getChapterContent, searchBooks } from '../../../utils/api'
import {
  STORAGE_KEYS,
  loadRecords,
  loadSources,
  type DownloadRecord,
  upsertRecord,
} from '../../../utils/storage'

const sources = ref<BookSource[]>([])
const enabledSources = computed(() => sources.value.filter((source) => source.enabled))
const keyword = ref('')
const searching = ref(false)
const hasSearched = ref(false)
const books = ref<BookItem[]>([])
const failedSources = ref<string[]>([])
const currentPage = ref(1)
const pageSize = 10
const pageCount = computed(() => Math.max(1, Math.ceil(books.value.length / pageSize)))
const pagedBooks = computed(() => books.value.slice((currentPage.value - 1) * pageSize, currentPage.value * pageSize))
const records = ref<DownloadRecord[]>([])
const downloadingKeys = ref(new Set<string>())

const onStorageChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
  if (area !== 'local') return
  const sourceChange = changes[STORAGE_KEYS.sources]
  if (sourceChange) sources.value = (sourceChange.newValue as BookSource[]) ?? []
  const recordChange = changes[STORAGE_KEYS.records]
  if (recordChange) {
    records.value = (recordChange.newValue as DownloadRecord[]) ?? []
    syncDownloadingKeys()
  }
}

onMounted(async () => {
  ;[sources.value, records.value] = await Promise.all([loadSources(), loadRecords()])
  syncDownloadingKeys()
  browser.storage.onChanged.addListener(onStorageChanged)
})
onBeforeUnmount(() => browser.storage.onChanged.removeListener(onStorageChanged))

async function handleSearch() {
  const query = keyword.value.trim()
  if (!query) return ElMessage.warning('请输入搜索关键词')
  if (!enabledSources.value.length) return ElMessage.warning('请先同步并启用书源')
  searching.value = true
  hasSearched.value = true
  books.value = []
  failedSources.value = []
  currentPage.value = 1
  const results = await Promise.allSettled(enabledSources.value.map(async (source) => {
    const sourceBooks = await searchBooks(query, source)
    return sourceBooks.map((book) => ({ ...book, sourceName: source.name, sourceUrl: source.url }))
  }))
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') books.value.push(...result.value)
    else failedSources.value.push(enabledSources.value[index]?.name ?? '未知书源')
  })
  books.value = sortByRelevance(books.value, query)
  searching.value = false
  if (!books.value.length) ElMessage.info('未搜索到结果')
}

function normalizeForSearch(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[\s\u3000"'“”‘’《》〈〉:：、，,。.!！？?\-_/]+/g, '')
}

function matchScore(value: string, query: string, exactScore: number, startsScore: number, includesScore: number): number {
  if (!value || !query) return 0
  if (value === query) return exactScore
  if (value.startsWith(query)) return startsScore
  const position = value.indexOf(query)
  return position >= 0 ? includesScore - Math.min(position, 50) : 0
}

function sortByRelevance(items: BookItem[], keyword: string): BookItem[] {
  const query = normalizeForSearch(keyword)
  return items
    .map((book, index) => {
      const title = normalizeForSearch(book.name)
      const author = normalizeForSearch(book.author)
      const titleScore = matchScore(title, query, 1000, 850, 700)
      const authorScore = matchScore(author, query, 560, 480, 400)
      return { book, index, score: Math.max(titleScore, authorScore) }
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ book }) => book)
}

function getBookKey(book: BookItem): string {
  return `${book.sourceUrl ?? book.sourceName ?? ''}|${book.detailUrl}`
}

function syncDownloadingKeys() {
  downloadingKeys.value = new Set(
    records.value
      .filter((record) => record.status === 'downloading')
      .map((record) => `${record.sourceUrl}|${record.detailUrl}`),
  )
}

function isDownloading(book: BookItem): boolean {
  return downloadingKeys.value.has(getBookKey(book))
}

function createRecordId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function safeFileName(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 100)
  return `${safe || '小说'}.txt`
}

function removeDuplicateChapterHeading(content: string, chapterName: string): string {
  const lines = content.split('\n')
  const first = lines[0]?.replace(/[\s：:]/g, '')
  const chapter = chapterName.replace(/[\s：:]/g, '')
  return first === chapter ? lines.slice(1).join('\n').trim() : content.trim()
}

async function handleDownload(book: BookItem) {
  if (isDownloading(book)) return
  const source = sources.value.find((item) => item.url === book.sourceUrl)
    ?? sources.value.find((item) => item.name === book.sourceName)
  if (!source) return ElMessage.error('找不到对应书源，请重新搜索')

  const key = getBookKey(book)
  const record: DownloadRecord = {
    id: createRecordId(),
    bookName: book.name,
    author: book.author || '未知',
    sourceName: source.name,
    sourceUrl: source.url,
    detailUrl: book.detailUrl,
    chapterCount: 0,
    completedChapters: 0,
    progress: 0,
    status: 'downloading',
    downloadedAt: Date.now(),
    fileName: safeFileName(book.name),
  }
  downloadingKeys.value = new Set(downloadingKeys.value).add(key)
  await upsertRecord(record)

  try {
    const chapters = await getCatalog(book.detailUrl, source)
    if (!chapters.length) throw new Error('未找到章节目录')
    record.chapterCount = chapters.length
    await upsertRecord({ ...record })

    const parts = [`${book.name}\n作者：${book.author || '未知'}\n`]
    for (let index = 0; index < chapters.length; index += 1) {
      const chapter = chapters[index]
      if (!chapter) continue
      const content = await getChapterContent(chapter.url, source)
      parts.push(`\n${chapter.name}\n${removeDuplicateChapterHeading(content, chapter.name)}\n`)
      record.completedChapters = index + 1
      record.progress = Math.round((record.completedChapters / record.chapterCount) * 100)
      await upsertRecord({ ...record })
    }

    const text = `\uFEFF${parts.join('\n')}`
    const url = `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`
    record.downloadId = await browser.downloads.download({
      url,
      filename: record.fileName,
      saveAs: false,
      conflictAction: 'uniquify',
    })
    record.progress = 100
    record.status = 'completed'
    record.downloadedAt = Date.now()
    await upsertRecord({ ...record })
    ElMessage.success(`《${book.name}》下载完成`)
  } catch (error) {
    record.status = 'failed'
    record.errorMessage = error instanceof Error ? error.message : '下载失败'
    await upsertRecord({ ...record })
    ElMessage.error(`《${book.name}》下载失败：${record.errorMessage}`)
  } finally {
    const next = new Set(downloadingKeys.value)
    next.delete(key)
    downloadingKeys.value = next
  }
}
</script>

<style lang="scss" scoped>
.search-list { display: flex; flex: 1 1 auto; flex-direction: column; height: 100%; min-height: 0; box-sizing: border-box; gap: 10px; overflow: hidden; padding: 0 12px 16px; }
.search-bar { position: sticky; top: 0; z-index: 1; padding: 8px 0; background: var(--el-bg-color); }
.result-section { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; }
.result-heading { display: flex; justify-content: space-between; padding-top: 2px; font-size: 13px; font-weight: 600; }
.page-info { color: var(--el-text-color-secondary); font-weight: 400; }
.result-scroll { flex: 1; min-height: 0; overflow-y: auto; padding-right: 2px; }
.book-item { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 4px; border-bottom: 1px solid var(--el-border-color-lighter); }
.book-main { min-width: 0; }
.book-title-row { display: flex; align-items: center; min-width: 0; gap: 8px; }
.book-name { min-width: 0; overflow: hidden; font-size: 14px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.source-tag { flex: 0 0 auto; max-width: none; white-space: nowrap; }
.book-meta { margin-top: 8px; overflow: hidden; color: var(--el-text-color-secondary); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.download-button { flex: 0 0 auto; white-space: nowrap; }
.loading-state { padding: 24px 0; color: var(--el-text-color-secondary); text-align: center; }
.page-footer { flex-shrink: 0; justify-content: center; margin-top: 6px; padding: 4px 0 0; background: var(--el-bg-color); }
</style>
