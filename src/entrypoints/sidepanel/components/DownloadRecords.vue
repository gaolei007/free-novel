<template>
  <div class="download-records">
    <div class="toolbar">
      <span class="count">
        共 {{ records.length }} 条记录<template v-if="incompleteCount"></template>
      </span>
      <el-button
        link
        type="danger"
        size="small"
        :disabled="!records.length"
        @click="handleClear"
      >
        清空记录
      </el-button>
    </div>

    <el-empty v-if="!records.length" description="暂无下载记录" :image-size="60" />

    <el-scrollbar v-else>
      <div v-for="record in records" :key="record.id" class="record-item">
        <div class="record-info">
          <div class="record-title-row">
            <div class="record-name">{{ record.bookName }}</div>
            <el-button
              v-if="record.downloadId != null"
              class="open-button"
              link
              type="primary"
              size="small"
              @click="openDownload(record.downloadId)"
            >打开</el-button>
          </div>
          <div class="record-meta">
            作者：{{ record.author || '未知' }} · 来源：{{ record.sourceName }} ·
            {{ formatTime(record.downloadedAt) }}
          </div>
          <el-progress
            v-if="record.status === 'downloading' || record.status === 'completed'"
            :percentage="record.progress ?? (record.status === 'completed' ? 100 : 0)"
            :status="record.status === 'completed' ? 'success' : undefined"
            :format="() => `${record.completedChapters ?? 0}/${record.chapterCount || '?'} 章`"
          />
          <div v-if="isInterrupted(record)" class="record-error">
            下载已中断（停在 {{ record.completedChapters ?? 0 }}/{{ record.chapterCount || '?' }} 章），已抓到的章节保存在本地
            <el-button class="detail-link" link type="danger" size="small" @click="openFailedDialog(record)">继续下载</el-button>
          </div>
          <div v-else-if="record.status === 'failed'" class="record-error">下载失败：{{ record.errorMessage || '未知错误' }}</div>
          <div v-else-if="record.failedChapters?.length" class="record-error">
            {{ record.failedChapters.length }} 章失败已跳过：{{ record.failedChapters.slice(0, 5).join('、') }}{{ record.failedChapters.length > 5 ? ' 等' : '' }}
            <el-button class="detail-link" link type="danger" size="small" @click="openFailedDialog(record)">详细信息</el-button>
          </div>
        </div>
      </div>
    </el-scrollbar>

    <el-dialog v-model="failedDialogVisible" title="失败章节明细" width="92%" append-to-body>
      <template v-if="interruptedHint">
        <el-alert class="failed-advice" :title="interruptedHint" type="warning" show-icon :closable="false" />
      </template>
      <template v-else>
        <div class="failed-summary">
          <div class="failed-book">{{ activeRecord?.bookName }}</div>
          <div class="failed-hint">来源：{{ activeRecord?.sourceName }} · 共 {{ failedDetails.length }} 章失败</div>
        </div>
        <div v-if="reasonSummary.length > 1" class="failed-reasons">
          <div v-for="item in reasonSummary" :key="item.reason" class="failed-reason-tag">
            <span class="reason-text">{{ item.reason }}</span>
            <span class="reason-count">×{{ item.count }}</span>
          </div>
        </div>
        <el-alert v-if="failureAdvice" class="failed-advice" :title="failureAdvice" type="info" show-icon :closable="false" />
        <div class="failed-list">
          <div v-for="(item, index) in failedDetails" :key="`${item.name}-${index}`" class="failed-item">
            <div class="failed-chapter">{{ item.name }}</div>
            <div class="failed-detail">{{ item.reason }}</div>
          </div>
        </div>
      </template>
      <template #footer>
        <el-button size="small" @click="failedDialogVisible = false">关闭</el-button>
        <el-button
          size="small"
          type="primary"
          :loading="refilling"
          :disabled="!canResume"
          @click="handleResume"
        >{{ refilling ? '下载中' : resumeLabel }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script lang="ts" setup>
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { FailedChapterInfo } from '../../../utils/downloader'
import { resumeDownload } from '../../../utils/bookDownload'
import { clearAllChapters, loadChapters } from '../../../utils/chapterStore'
import { describeError } from '../../../utils/errors'
import {
  STORAGE_KEYS,
  clearRecords,
  countIncompleteRecords,
  loadRecords,
  loadSources,
  upsertRecord,
  type DownloadRecord,
} from '../../../utils/storage'

/** 超过这个时间没有进度写入，就认为「下载中」的记录已经中断（比如关了侧边栏） */
const STALE_MS = 60_000

const records = ref<DownloadRecord[]>([])
const failedDialogVisible = ref(false)
const refilling = ref(false)
const activeRecordId = ref<string | null>(null)
/** 弹窗打开时从缓存里数出来的缺失章节数，null 表示读不到缓存 */
const pendingCount = ref<number | null>(null)
const now = ref(Date.now())

let ticker: ReturnType<typeof setInterval> | undefined

/** 按 id 从最新记录里取，storage 一变弹窗内容就跟着更新 */
const activeRecord = computed(() => records.value.find((record) => record.id === activeRecordId.value) ?? null)

/** 与侧边栏徽标同口径：只数还没下完的（下载中/中断/失败/残本） */
const incompleteCount = computed(() => countIncompleteRecords(records.value))

/** 「下载中」但很久没有进度更新 = 已中断，可以继续下 */
function isInterrupted(record: DownloadRecord): boolean {
  if (record.status !== 'downloading') return false
  const last = record.updatedAt ?? record.downloadedAt ?? 0
  return now.value - last > STALE_MS
}

const activeInterrupted = computed(() => !!activeRecord.value && isInterrupted(activeRecord.value))

const canResume = computed(() => {
  const record = activeRecord.value
  if (!record || refilling.value) return false
  if (pendingCount.value === null) return false
  return record.status === 'failed'
    || isInterrupted(record)
    || !!record.failedChapterDetails?.length
    || pendingCount.value > 0
})

const resumeLabel = computed(() => (activeInterrupted.value || activeRecord.value?.status === 'failed' ? '继续下载' : '补下失败章节'))

const failedDetails = computed<FailedChapterInfo[]>(() => {
  const record = activeRecord.value
  if (!record) return []
  const details = record.failedChapterDetails
  if (details?.length) return details
  // 中断的记录还没结算过失败明细，只展示提示；旧记录则给个占位说明
  if (isInterrupted(record)) return []
  return (record.failedChapters ?? []).map((name, index) => ({
    index,
    name,
    url: '',
    reason: '该记录未保存失败原因（旧版本下载），无法单独补章',
  }))
})

/** 弹窗里对「中断」场景的说明 */
const interruptedHint = computed(() => {
  if (!activeInterrupted.value) return ''
  if (pendingCount.value === null) return '本地缓存已不存在，无法续传，请重新下载整本。'
  if (!pendingCount.value) return '本地缓存里章节已齐全，直接点下面的按钮就能重组出完整文件。'
  return `本地已保存 ${activeRecord.value?.chapterCount ?? 0} 章的目录，其中 ${pendingCount.value} 章没有正文。点「继续下载」只会重抓这 ${pendingCount.value} 章，已下好的不会重来。`
})

/** 相同原因归并计数，先让用户看清是限流还是别的 */
const reasonSummary = computed(() => {
  const counter = new Map<string, number>()
  for (const item of failedDetails.value) {
    counter.set(item.reason, (counter.get(item.reason) ?? 0) + 1)
  }
  return [...counter.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
})

/** 把状态码翻译成能照着做的结论 */
const failureAdvice = computed(() => {
  if (!failedDetails.value.length) return ''
  const text = failedDetails.value.map((item) => item.reason).join(' ')
  if (/HTTP\s*(429|403|503|502|5\d\d)/i.test(text)) return '站点返回限流类状态码（403/429/5xx），多数是并发请求过快被拦。隔几分钟重新下载通常能补齐。'
  if (text.includes('超时')) return '单章请求超时，多为站点响应慢或瞬时抽风，重试一般能拿到。'
  if (text.includes('未保存失败原因')) return '这条记录是旧版本下载的，未保存失败原因。重新下载一次即可看到明细。'
  return '可在浏览器里打开对应章节页，确认该章是否仍能正常访问。'
})

// 在搜索页完成下载后同步更新列表
const onStorageChanged = (
  changes: Record<string, { newValue?: unknown }>,
  area: string,
) => {
  const change = changes[STORAGE_KEYS.records]
  if (area !== 'local' || !change) return
  records.value = (change.newValue as DownloadRecord[]) ?? []
}

onMounted(async () => {
  records.value = await loadRecords()
  browser.storage.onChanged.addListener(onStorageChanged)
  // 记录里没有心跳，靠本地计时器判断「下载中」是否已经中断
  ticker = setInterval(() => (now.value = Date.now()), 10_000)
})

onBeforeUnmount(() => {
  browser.storage.onChanged.removeListener(onStorageChanged)
  if (ticker) clearInterval(ticker)
})

function handleClear() {
  void clearRecords().then(() => {
    records.value = []
    void clearAllChapters()
  })
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

async function openFailedDialog(record: DownloadRecord) {
  activeRecordId.value = record.id
  failedDialogVisible.value = true
  pendingCount.value = null
  try {
    const cached = await loadChapters(record.id)
    pendingCount.value = cached.length ? cached.filter((chapter) => !chapter.content).length : null
  } catch {
    pendingCount.value = null
  }
}

/** 续传 / 补章：只重抓缓存里没有正文的章节，再重组整本覆盖同名文件 */
async function handleResume() {
  const current = activeRecord.value
  if (!current || refilling.value) return
  const sources = await loadSources()
  const source = sources.find((item) => item.url === current.sourceUrl)
    ?? sources.find((item) => item.name === current.sourceName)
  if (!source) {
    ElMessage.error('找不到对应书源，请先同步书源')
    return
  }

  refilling.value = true
  // 本地维护一份可变副本，逐次写回；进度靠记录页已有的进度条呈现
  const record: DownloadRecord = { ...current }
  const missing = pendingCount.value ?? 0
  const doneBefore = Math.max(0, (record.chapterCount || 0) - missing)
  record.status = 'downloading'
  record.progress = Math.round((doneBefore / Math.max(1, record.chapterCount)) * 100)
  record.updatedAt = Date.now()
  await upsertRecord({ ...record })

  try {
    let lastSave = 0
    const { filled, stillFailed, downloadId, contentCount } = await resumeDownload({
      record,
      source,
      onProgress: (completed, total, failed) => {
        record.completedChapters = doneBefore + completed - failed
        record.progress = Math.round(((doneBefore + completed - failed) / Math.max(1, record.chapterCount)) * 100)
        record.updatedAt = Date.now()
        const stamp = Date.now()
        if (stamp - lastSave >= 1000) {
          lastSave = stamp
          void upsertRecord({ ...record })
        }
      },
    })

    record.downloadId = downloadId
    record.completedChapters = contentCount
    record.progress = 100
    record.status = 'completed'
    record.failedChapterDetails = stillFailed
    record.failedChapters = stillFailed.map((item) => item.name)
    record.errorMessage = stillFailed.length
      ? `${stillFailed.length} 章重试后仍失败已跳过：${stillFailed.slice(0, 5).map((item) => item.name).join('、')}${stillFailed.length > 5 ? ' 等' : ''}`
      : undefined
    record.downloadedAt = Date.now()
    record.updatedAt = Date.now()
    await upsertRecord({ ...record })
    pendingCount.value = stillFailed.length

    if (stillFailed.length) {
      ElMessage.warning(`已补齐 ${filled} 章，仍有 ${stillFailed.length} 章失败`)
    } else {
      failedDialogVisible.value = false
      ElMessage.success(`已补齐 ${filled} 章，《${record.bookName}》现在是完整的`)
    }
  } catch (error) {
    record.status = current.status
    record.progress = current.progress
    record.updatedAt = Date.now()
    await upsertRecord({ ...record })
    ElMessage.error(`续传失败：${describeError(error) || '未知错误'}`)
  } finally {
    refilling.value = false
  }
}

function openDownload(downloadId: number) {
  void browser.downloads.show(downloadId)
}
</script>

<style lang="scss" scoped>
.download-records {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 0 12px;

  .toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 0;

    .count {
      font-size: 12px;
      color: var(--el-text-color-secondary);
    }

    .pending {
      color: var(--el-color-danger);
    }
  }

  .record-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 4px;
    border-bottom: 1px solid var(--el-border-color-lighter);
  }

  .record-info {
    flex: 1;
    min-width: 0;
  }

  .record-name {
    min-width: 0;
    flex: 1;
    font-size: 14px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .record-title-row {
    display: flex;
    align-items: center;
    min-width: 0;
    gap: 8px;
  }

  .record-meta {
    margin-top: 2px;
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }

  :deep(.el-progress) {
    width: 100%;
    margin-top: 8px;
  }

  :deep(.el-progress__text) {
    min-width: 0;
  }

  .record-error {
    margin-top: 6px;
    color: var(--el-color-danger);
    font-size: 12px;
    line-height: 1.6;
  }

  .detail-link {
    height: auto;
    padding: 0;
    font-size: inherit;
    vertical-align: baseline;
  }

  .failed-summary {
    margin-bottom: 10px;
  }

  .failed-book {
    font-size: 13px;
    font-weight: 600;
  }

  .failed-hint {
    margin-top: 2px;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }

  .failed-reasons {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 10px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--el-border-color-lighter);
  }

  .failed-reason-tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 100%;
    padding: 2px 8px;
    border-radius: 4px;
    background: var(--el-fill-color);
    font-size: 12px;
  }

  .reason-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .reason-count {
    flex-shrink: 0;
    color: var(--el-color-danger);
    font-weight: 600;
  }

  .failed-advice {
    margin-bottom: 10px;
  }

  .failed-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 50vh;
    overflow-y: auto;
  }

  .failed-item {
    padding: 8px 10px;
    border: 1px solid var(--el-border-color-lighter);
    border-radius: 6px;
    background: var(--el-fill-color-lighter);
  }

  .failed-chapter {
    font-size: 13px;
    font-weight: 500;
    word-break: break-all;
  }

  .failed-detail {
    margin-top: 4px;
    color: var(--el-text-color-secondary);
    font-size: 12px;
    line-height: 1.6;
    word-break: break-all;
  }

  .open-button {
    flex-shrink: 0;
    white-space: nowrap;
  }

  .record-icon {
    flex-shrink: 0;
    color: var(--el-text-color-secondary);
  }
}
</style>
