<template>
  <div class="search-list">
    <div class="search-bar">
      <el-input v-model="keyword" placeholder="输入书名或作者" clearable @keyup.enter="handleSearch">
        <template #append><el-button :loading="searching" @click="handleSearch"><el-icon><Search /></el-icon>搜索</el-button></template>
      </el-input>
    </div>

    <el-alert v-if="!enabledSources.length" title="暂无可搜索书源，请先同步 so-novel 书源" type="info" show-icon :closable="false" />
    <el-alert v-else-if="failedSources.length" type="warning" show-icon :closable="false" class="failed-alert">
      <template #title>
        <span>{{ failedSources.length }} 个书源搜索失败，</span>
        <el-button class="failed-link" link type="warning" @click="failedDialogVisible = true">查看失败原因</el-button>
      </template>
    </el-alert>

    <el-dialog
      v-model="failedDialogVisible" title="书源搜索失败原因" width="95%"
      append-to-body :show-close="false"
    >
      <div v-if="failedSources.length" class="failed-list">
        <div v-for="item in failedSources" :key="item.name" class="failed-item">
          <div class="failed-name">
            <span>{{ item.name }}</span>
            <el-button class="failed-open" link type="primary" @click="openUrl(item.url)">打开书源</el-button>
          </div>
          <div class="failed-reason">{{ item.reason }}</div>
        </div>
      </div>
      <el-empty v-else description="暂无失败记录" :image-size="48" />
      <template #footer>
        <el-button size="small" @click="failedDialogVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <div v-if="pagedBooks.length" class="result-section">
      <div class="result-heading"><span>搜索结果（{{ books.length }}）</span><span class="page-info">第 {{ currentPage }} / {{ pageCount }} 页</span></div>
      <div class="result-scroll">
        <div v-for="(book, index) in pagedBooks" :key="`${book.sourceName}-${book.detailUrl}-${index}`" class="book-item">
          <div class="book-main">
            <div class="book-title-row">
              <el-tag class="source-tag" size="small" effect="plain">{{ book.sourceName }}</el-tag>
              <el-link class="book-name" type="primary" :underline="false" title="在当前标签页打开详情页" @click="openUrl(book.detailUrl)">
                <span class="book-name-text">{{ book.name }}</span>
              </el-link>
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
import { getCatalog, searchBooks } from '../../../utils/api'
import {
  buildBookText,
  fetchAndCacheBook,
  looksLikeDuplicatedContent,
  safeFileName,
  triggerTextDownload,
} from '../../../utils/bookDownload'
import { describeError } from '../../../utils/errors'
import { isSafeHttpUrl } from '../../../utils/urlSafety'
import {
  STORAGE_KEYS,
  loadRecords,
  loadSources,
  type DownloadRecord,
  upsertRecord,
} from '../../../utils/storage'

interface FailedSource {
  name: string
  url: string
  reason: string
  /** 保留书源对象，便于只重试失败的那几个 */
  source: BookSource
}

const sources = ref<BookSource[]>([])
const enabledSources = computed(() => sources.value.filter((source) => source.enabled))
const keyword = ref('')
const searching = ref(false)
const hasSearched = ref(false)
const books = ref<BookItem[]>([])
const failedSources = ref<FailedSource[]>([])
const failedDialogVisible = ref(false)
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

/** 同时打出去的书源数量。十几个请求一起发很容易被站点限流，排队慢慢来更稳 */
const SOURCE_CONCURRENCY = 4

async function searchOneSource(source: BookSource, query: string): Promise<BookItem[]> {
  const sourceBooks = await searchBooks(query, source)
  return sourceBooks.map((book) => ({ ...book, sourceName: source.name, sourceUrl: source.url }))
}

/** 限定并发地搜索一批书源，每完成一个就回调一次，结果边搜边出 */
async function searchSources(
  targets: BookSource[],
  query: string,
  onUpdate?: (found: BookItem[], failed: FailedSource[]) => void,
) {
  const found: BookItem[] = []
  const failed: FailedSource[] = []
  let cursor = 0
  const flush = () => onUpdate?.([...found], [...failed])
  const worker = async () => {
    while (cursor < targets.length) {
      const source = targets[cursor]
      cursor += 1
      if (!source) break
      try {
        found.push(...(await searchOneSource(source, query)))
      } catch (error) {
        failed.push({
          name: source.name,
          url: source.url,
          source,
          reason: describeError(error) || '未返回任何结果',
        })
      }
      flush()
    }
  }
  await Promise.all(Array.from({ length: Math.min(SOURCE_CONCURRENCY, targets.length) }, () => worker()))
  return { found, failed }
}

async function handleSearch() {
  if (searching.value) return
  const query = keyword.value.trim()
  if (!query) return ElMessage.warning('请输入搜索关键词')
  if (!enabledSources.value.length) return ElMessage.warning('请先同步并启用书源')
  searching.value = true
  hasSearched.value = true
  books.value = []
  failedSources.value = []
  currentPage.value = 1
  const applyUpdate = (currentBooks: BookItem[], currentFailed: FailedSource[]) => {
    books.value = sortByRelevance(currentBooks, query)
    failedSources.value = currentFailed
  }
  await searchSources([...enabledSources.value], query, applyUpdate)
  searching.value = false
  if (!books.value.length) ElMessage.info('未搜索到结果')
}

/** 只重搜失败的书源，已成功的书源不重复请求，避免再次触发限流 */
async function retryFailedSources() {
  if (searching.value) return
  const query = keyword.value.trim()
  if (!query) return ElMessage.warning('请输入搜索关键词')
  const targets = failedSources.value.map((item) => item.source)
  if (!targets.length) return
  const previousCount = targets.length
  const kept = [...books.value]
  searching.value = true
  failedSources.value = []
  const { found, failed } = await searchSources(targets, query, (currentBooks, currentFailed) => {
    books.value = sortByRelevance([...kept, ...currentBooks], query)
    failedSources.value = currentFailed
  })
  books.value = sortByRelevance([...kept, ...found], query)
  failedSources.value = failed
  searching.value = false
  if (!failed.length) ElMessage.success(`已重试 ${previousCount} 个书源，全部恢复`)
  else if (failed.length < previousCount) ElMessage.warning(`已重试 ${previousCount} 个书源，仍有 ${failed.length} 个失败`)
  else ElMessage.error(`重试后仍有 ${failed.length} 个书源失败`)
}

/** 在当前标签页打开地址（复用当前窗口的活动标签，不新开标签），先做安全校验 */
async function openUrl(target?: string) {
  if (!target || !isSafeHttpUrl(target)) {
    ElMessage.warning('该地址无效或不受信任，已阻止打开')
    return
  }
  try {
    // currentWindow 取侧边栏所在窗口的活动标签，直接把当前页面导航过去
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
    if (tab?.id != null) {
      await browser.tabs.update(tab.id, { url: target, active: true })
      return
    }
    // 查不到活动标签（极少见）时退化为新开一个，避免点了没反应
    await browser.tabs.create({ url: target, active: true })
  } catch (error) {
    ElMessage.error(`打开失败：${describeError(error) || '未知错误'}`)
  }
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
    updatedAt: Date.now(),
    fileName: safeFileName(book.name),
  }
  downloadingKeys.value = new Set(downloadingKeys.value).add(key)
  await upsertRecord(record)

  try {
    const chapters = await getCatalog(book.detailUrl, source)
    if (!chapters.length) throw new Error('未找到章节目录')
    record.chapterCount = chapters.length
    await upsertRecord({ ...record })

    // 并发抓取并写入本地缓存（缓存是「补章」的前提），进度每 2s 节流写一次 storage
    let lastSave = 0
    const { contents, failedChapters, failedDetails } = await fetchAndCacheBook(
      source,
      record.id,
      chapters,
      (completed, total, failed) => {
        record.completedChapters = completed
        record.progress = Math.round((completed / total) * 100)
        record.failedChapters = failed
        record.updatedAt = Date.now()
        const now = Date.now()
        if (now - lastSave >= 2000) {
          lastSave = now
          void upsertRecord({ ...record })
        }
      },
    )

    const text = buildBookText(
      book.name,
      book.author || '未知',
      chapters.map((chapter, index) => ({ name: chapter.name, content: contents[index] ?? '' })),
    )
    if (!text.trim()) throw new Error('所有章节下载失败，站点可能限流，请稍后重试')
    if (looksLikeDuplicatedContent(contents)) {
      throw new Error('章节内容疑似大量重复（书源翻页规则异常），已中止导出。请先同步书源，再重新下载')
    }

    record.downloadId = await triggerTextDownload(record.fileName ?? safeFileName(book.name), text)
    record.completedChapters = chapters.length - failedChapters.length
    record.progress = 100
    record.failedChapters = failedChapters
    record.failedChapterDetails = failedDetails
    record.status = failedChapters.length >= chapters.length ? 'failed' : 'completed'
    if (failedChapters.length) {
      record.errorMessage = `${failedChapters.length} 章重试后仍失败已跳过：${failedChapters.slice(0, 5).join('、')}${failedChapters.length > 5 ? ' 等' : ''}`
    }
    record.downloadedAt = Date.now()
    record.updatedAt = Date.now()
    await upsertRecord({ ...record })
    ElMessage.success(
      failedChapters.length
        ? `《${book.name}》下载完成，${failedChapters.length} 章失败已跳过`
        : `《${book.name}》下载完成`,
    )
  } catch (error) {
    record.status = 'failed'
    record.errorMessage = error instanceof Error ? error.message : '下载失败'
    record.updatedAt = Date.now()
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
/* alert 标题里的行内按钮：抵消 el-button 的默认高度/内边距，避免撑高标题行 */
.failed-alert :deep(.el-alert__title) { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; word-break: break-all; }
.failed-alert :deep(.failed-link) { height: auto; padding: 0; font-size: inherit; vertical-align: baseline; }
.failed-list { display: flex; flex-direction: column; gap: 12px; max-height: 50vh; overflow-y: auto; }
.failed-item { padding: 8px 10px; border: 1px solid var(--el-border-color-lighter); border-radius: 6px; background: var(--el-fill-color-lighter); }
.failed-name { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; font-weight: 600; }
.failed-open { height: auto; padding: 0; font-size: 12px; }
.failed-reason { margin-top: 6px; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; word-break: break-all; }
.result-scroll { flex: 1; min-height: 0; overflow-y: auto; padding-right: 2px; }
.book-item { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 4px; border-bottom: 1px solid var(--el-border-color-lighter); }
.book-main { min-width: 0; }
.book-title-row { display: flex; align-items: center; min-width: 0; gap: 8px; }
.book-name { min-width: 0; justify-content: flex-start; height: auto; font-size: 14px; font-weight: 600; }
.book-name-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.book-name-icon { flex: 0 0 auto; margin-left: 4px; font-size: 12px; opacity: 0.65; }
.source-tag { flex: 0 0 auto; max-width: none; white-space: nowrap; }
.book-meta { margin-top: 8px; overflow: hidden; color: var(--el-text-color-secondary); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.download-button { flex: 0 0 auto; white-space: nowrap; }
.loading-state { padding: 24px 0; color: var(--el-text-color-secondary); text-align: center; }
.page-footer { flex-shrink: 0; justify-content: center; margin-top: 6px; padding: 4px 0 0; background: var(--el-bg-color); }
</style>
