<template>
  <div class="search-list">
    <!-- 搜索框：图标 + 输入 + 内嵌按钮，一体化 -->
    <el-input
      v-model="keyword"
      class="search-field"
      placeholder="输入书名或作者"
      @keyup.enter="handleSearch"
    >
      <template #prefix><el-icon class="search-icon"><Search /></el-icon></template>
      <template #suffix>
        <el-button class="search-btn" type="primary" :loading="searching" @click="handleSearch">搜索</el-button>
      </template>
    </el-input>

    <div v-if="searching" class="loading-state">
      <el-icon class="is-loading"><Loading /></el-icon>
      <span>正在搜索 {{ keyword }} ···</span>
    </div>

    <el-alert
      v-if="!enabledSources.length"
      class="hint-alert"
      title="暂无可搜索书源，请先同步 so-novel 书源"
      type="info"
      show-icon
      :closable="false"
    />

    <el-alert
      v-else-if="failedSources.length"
      class="failed-alert"
      type="warning"
      :show-icon="false"
      :closable="false"
    >
      <template #title>
        <span class="alert-inner">
          <span class="alert-text">
            <el-icon class="alert-icon"><Warning /></el-icon>
            <span>{{ failedSources.length }} 个书源搜索失败</span>
          </span>
          <el-button class="alert-action" link type="warning" @click="failedDialogVisible = true">
            查看失败原因<el-icon><ArrowRight /></el-icon>
          </el-button>
        </span>
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
        <el-button size="small" type="primary" :loading="searching" @click="retryFailedSources">重试失败书源</el-button>
      </template>
    </el-dialog>

    <template v-if="pagedBooks.length">
      <div class="result-meta">
        <span class="meta-left">搜索结果<span class="meta-count">{{ books.length }}</span></span>
        <span class="page-indicator">第 {{ currentPage }} / {{ pageCount }} 页</span>
      </div>

      <div class="result-list">
        <article v-for="(book, index) in pagedBooks" :key="`${book.sourceName}-${book.detailUrl}-${index}`" class="result-card">
          <div class="card-head">
            <div class="title-group">
              <span class="source-tag">{{ book.sourceName }}</span>
              <span
                class="book-title"
                role="link"
                tabindex="0"
                title="在当前标签页打开详情页"
                @click="openUrl(book.detailUrl)"
                @keydown.enter="openUrl(book.detailUrl)"
                @keydown.space.prevent="openUrl(book.detailUrl)"
              >{{ book.name }}</span>
            </div>
            <el-button
              class="dl-btn"
              type="primary"
              plain
              :loading="isDownloading(book)"
              :disabled="isDownloading(book)"
              @click="handleDownload(book)"
            >{{ isDownloading(book) ? '下载中' : '下载' }}</el-button>
          </div>
          <div class="card-meta">
            <span>作者：{{ book.author || '未知' }}</span>
            <span>最近章节：{{ book.latestChapter || '未知' }}</span>
          </div>
        </article>
      </div>

      <el-pagination
        class="page-footer"
        v-model:current-page="currentPage"
        small
        :pager-count="7"
        layout="prev, pager, next"
        :page-size="pageSize"
        :total="books.length"
      />
    </template>

    <el-empty
      v-else-if="!searching"
      class="empty-state"
      :description="hasSearched ? '没有找到匹配的小说' : '输入书名或作者开始搜索'"
      :image-size="64"
    />
  </div>
</template>

<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { ArrowRight, Loading, Search, Warning } from '@element-plus/icons-vue'
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
.search-list {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
}

/* ---------- 搜索框（el-input + 内嵌按钮） ---------- */
.search-field {
  flex: 0 0 36px;
  font-size: 13px;

  :deep(.el-input__wrapper) {
    padding: 4px;
    border-radius: 8px;
    background: var(--cd-panel);
    box-shadow: inset 0 0 0 1px var(--cd-input-border);
  }

  :deep(.el-input__wrapper.is-focus) {
    box-shadow: inset 0 0 0 1px var(--cd-primary);
  }

  :deep(.el-input__inner) {
    height: 28px;
    line-height: 28px;
    font-size: 13px;
    color: var(--cd-text-primary);
  }

  :deep(.el-input__inner::placeholder) {
    color: var(--cd-placeholder);
  }

  :deep(.el-input__prefix) {
    width: 32px;
    justify-content: center;
    margin: 0;
    font-size: 16px;
  }

  :deep(.el-input__suffix) {
    margin: 0;
  }

  .search-icon {
    color: var(--cd-placeholder);
  }

  .search-btn {
    --el-button-size: 28px;
    flex: 0 0 56px;
    width: 56px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
  }
}

/* ---------- 提示条 ---------- */
.hint-alert,
.failed-alert {
  flex: 0 0 40px;
  padding: 0 12px;
  border-radius: 8px;
  justify-content: center;
}

.failed-alert {
  background: var(--cd-warn-bg);

  :deep(.el-alert__icon) {
    margin-right: 6px;
    font-size: 14px;
    color: var(--cd-warn);
  }

  :deep(.el-alert__content) {
    flex: 1 1 auto;
    min-width: 0;
    padding: 0;
  }

  :deep(.el-alert__title) {
    margin: 0;
    font-size: 12px;
    line-height: 16px;
    color: var(--cd-warn);
  }

  :deep(.el-alert__description) {
    display: none;
  }
}

.alert-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  width: 100%;
}

/* 图标与文字用 flex 居中，避免 inline 基线对齐导致图标偏高 */
.alert-text {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
  line-height: 16px;
  color: var(--cd-warn);
  /* 定高 40px，文案过长时省略而不是换行撑破 */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.alert-icon {
  flex: 0 0 auto;
  font-size: 14px;
}

.alert-action {
  flex: 0 0 auto;
  height: auto;
  padding: 0;
  font-size: 12px;
  line-height: 16px;
  font-weight: 500;

  &:hover {
    text-decoration: underline;
  }

  :deep(.el-icon) {
    margin-left: 2px;
  }
}

/* ---------- 结果元信息 ---------- */
.result-meta {
  display: flex;
  flex: 0 0 20px;
  align-items: center;
  justify-content: space-between;
}

.meta-left {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  line-height: 18px;
  color: var(--cd-text-regular);
}

.meta-count {
  color: var(--cd-primary);
  font-weight: 600;
}

.page-indicator {
  font-size: 11px;
  line-height: 16px;
  color: var(--cd-text-secondary);
}

/* ---------- 结果卡片 ---------- */
.result-list {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;
}

.result-card {
  display: flex;
  flex: 0 0 74px;
  flex-direction: column;
  gap: 4px;
  box-sizing: border-box;
  padding: 8px;
  border-radius: 8px;
  background: var(--cd-panel);
  box-shadow: inset 0 0 0 1px var(--cd-card-border);
}

.card-head {
  display: flex;
  flex: 0 0 22px;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.title-group {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.source-tag {
  flex: 0 0 auto;
  padding: 4px;
  border-radius: 4px;
  background: var(--cd-tag-bg);
  color: var(--cd-primary);
  /* 暗色靠这圈描边锚住轮廓，亮色下为 transparent 不生效 */
  box-shadow: inset 0 0 0 1px var(--cd-tag-ring);
  font-size: 11px;
  line-height: 14px;
  font-weight: 500;
  white-space: nowrap;
}

/* 书名是链接：可点击进阅读页，只靠主色标识，不带下划线 */
.book-title {
  display: block;
  /* 允许在 flex 行内收缩，长书名才会正确出省略号 */
  min-width: 0;
  font-size: 14px;
  line-height: 18px;
  font-weight: 500;
  color: var(--cd-primary);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  transition: color 0.2s;
}

.book-title:hover {
  color: var(--cd-primary-hover);
}

.book-title:focus-visible {
  outline: 2px solid rgba(64, 158, 255, 0.35);
  outline-offset: 1px;
  border-radius: 2px;
}

.dl-btn {
  --el-button-size: 22px;
  flex: 0 0 52px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: var(--cd-primary-soft);
  color: var(--cd-primary);
  box-shadow: inset 0 0 0 1px var(--cd-primary-soft-border);
  font-size: 11px;
  line-height: 14px;
  font-weight: 500;

  &:hover:not(.is-disabled) {
    background: var(--cd-primary);
    color: #fff;
  }

  /* 下载中：按钮置灰但仍可读，避免被 EP 的 is-disabled 样式盖掉自定义底色 */
  &.is-disabled,
  &.is-disabled:hover {
    background: var(--cd-primary-soft);
    color: var(--cd-icon-weak);
    box-shadow: inset 0 0 0 1px var(--cd-primary-soft-border);
  }
}

.card-meta {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  min-height: 0;
  font-size: 11px;
  line-height: 15px;
  color: var(--cd-text-secondary);
}

.card-meta span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- 分页 ---------- */
.page-footer {
  display: flex;
  flex: 0 0 40px;
  align-items: center;
  justify-content: center;
  gap: 4px;

  --el-pagination-font-size: 12px;
  --el-pagination-button-width: 24px;
  --el-pagination-button-height: 24px;
  /* 页码/箭头都不带底色，靠当前页的主色块区分 */
  --el-pagination-bg-color: transparent;
  --el-pagination-button-bg-color: transparent;
  --el-pagination-text-color: var(--cd-text-regular);
  --el-pagination-hover-color: var(--cd-primary);
  --el-pagination-border-radius: 6px;
  --el-pagination-button-disabled-color: var(--cd-icon-weak);
  --el-pagination-button-disabled-bg-color: transparent;

  /* EP 给页码 4px 外边距、给箭头 16px item-gap，统一交给容器的 gap 控制 */
  :deep(.btn-prev),
  :deep(.btn-next),
  :deep(.el-pager li) {
    margin: 0;
  }

  :deep(.btn-prev),
  :deep(.btn-next) {
    color: var(--cd-icon-weak);

    .el-icon {
      font-size: 14px;
      font-weight: 400;
    }
  }

  :deep(.el-pager li) {
    color: var(--cd-text-regular);
    font-weight: 400;
  }

  :deep(.el-pager li.is-active) {
    color: #fff;
    font-weight: 500;
  }

  :deep(.el-pager li.more) {
    color: var(--cd-icon-weak);
  }
}

/* ---------- 空态 / 加载态 ---------- */
.empty-state {
  flex: 1 1 auto;
  justify-content: center;
}

.loading-state {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--cd-text-secondary);
  font-size: 12px;
}

/* ---------- 失败原因弹窗 ---------- */
.failed-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 50vh;
  overflow-y: auto;
}

.failed-item {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--cd-panel);
  box-shadow: inset 0 0 0 1px var(--cd-card-border);
}

.failed-name {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
  font-weight: 500;
}

.failed-open {
  height: auto;
  padding: 0;
  font-size: 12px;
}

.failed-reason {
  margin-top: 4px;
  color: var(--cd-text-secondary);
  font-size: 11px;
  line-height: 15px;
  word-break: break-all;
}
</style>
