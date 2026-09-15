<template>
  <div class="source-config">
    <section class="source-summary">
      <div class="summary-info">
        <div class="count-row">
          <span class="count-label">本地书源</span>
          <span class="count-value">{{ sources.length }} 个</span>
        </div>
        <span v-if="lastSyncAt" class="last-sync">最近同步 {{ formatTime(lastSyncAt) }}</span>
        <span v-else class="last-sync">尚未同步过</span>
      </div>
      <el-button class="sync-btn" type="primary" :loading="syncing" @click="handleSync">
        {{ syncing ? '同步中' : '立即同步' }}
      </el-button>
    </section>

    <el-alert v-if="errorMessage" class="sync-error" :title="errorMessage" type="error" show-icon :closable="false" />

    <el-empty v-if="!sources.length" class="empty-state" description="暂无本地书源，请先同步" :image-size="64" />

    <section v-else class="source-list">
      <div v-for="source in sources" :key="source.url" class="source-row">
        <span class="status-dot" />
        <div class="source-info">
          <span class="source-name">{{ source.name }}</span>
          <span class="source-url">{{ source.url }}</span>
        </div>
        <el-button
          class="del-btn"
          link
          :icon="Delete"
          :disabled="syncing"
          :aria-label="`删除 ${source.name}`"
          @click="handleRemove(source)"
        />
      </div>
    </section>
  </div>
</template>

<script lang="ts" setup>
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Refresh } from '@element-plus/icons-vue'
import type { BookSource } from '../../../types/source'
import { loadSources, saveSources } from '../../../utils/storage'
import { syncSoNovelSources } from '../../../utils/sourceSync'

const sources = ref<BookSource[]>([])
const syncing = ref(false)
const errorMessage = ref('')
const lastSyncAt = ref<number | null>(null)

onMounted(async () => {
  sources.value = await loadSources()
  const { lastSourceSyncAt } = await browser.storage.local.get('lastSourceSyncAt')
  lastSyncAt.value = typeof lastSourceSyncAt === 'number' ? lastSourceSyncAt : null
})

async function handleSync() {
  syncing.value = true
  errorMessage.value = ''
  try {
    const result = await syncSoNovelSources()
    sources.value = await loadSources()
    lastSyncAt.value = Date.now()
    await browser.storage.local.set({ lastSourceSyncAt: lastSyncAt.value })
    ElMessage.success(`同步完成：新增 ${result.added} 个，更新 ${result.updated} 个`)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '同步失败，请稍后重试'
  } finally { syncing.value = false }
}

async function handleRemove(source: BookSource) {
  try {
    await ElMessageBox.confirm(
      `确定移除书源“${source.name}”吗？移除后仍可通过同步重新添加。`,
      '移除书源',
      { type: 'warning', confirmButtonText: '移除', cancelButtonText: '取消' },
    )
    const nextSources = sources.value.filter((item) => item.url !== source.url)
    await saveSources(nextSources)
    sources.value = nextSources
    ElMessage.success(`已移除书源：${source.name}`)
  } catch (error) {
    // 用户取消确认时不提示错误。
    if (error !== 'cancel' && error !== 'close') {
      errorMessage.value = error instanceof Error ? error.message : '移除失败，请稍后重试'
    }
  }
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(timestamp)
}
</script>

<style lang="scss" scoped>
.source-config {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
}

/* ---------- 概览卡 ---------- */
.source-summary {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
  border-radius: 8px;
  background: var(--cd-panel);
  box-shadow: inset 0 0 0 1px var(--cd-card-border);
}

.summary-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.count-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.count-label {
  font-size: 11px;
  line-height: 15px;
  color: var(--cd-text-secondary);
}

.count-value {
  font-size: 15px;
  line-height: 20px;
  font-weight: 600;
  color: var(--cd-text-primary);
}

.last-sync {
  font-size: 11px;
  line-height: 15px;
  color: var(--cd-text-secondary);
}

.sync-btn {
  --el-button-size: 30px;
  flex: 0 0 auto;
  width: 92px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;

  :deep(.el-icon) {
    margin-right: 4px;
  }
}

.sync-error {
  flex: 0 0 auto;
  border-radius: 8px;
}

/* ---------- 书源列表 ---------- */
.source-list {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;
}

.source-row {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border-radius: 8px;
  background: var(--cd-panel);
  box-shadow: inset 0 0 0 1px var(--cd-card-border);
}

.status-dot {
  flex: 0 0 8px;
  width: 8px;
  height: 8px;
  border-radius: 4px;
  background: var(--cd-success);
}

.source-info {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.source-name {
  overflow: hidden;
  font-size: 13px;
  line-height: 18px;
  font-weight: 500;
  color: var(--cd-text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-url {
  overflow: hidden;
  font-size: 11px;
  line-height: 14px;
  color: var(--cd-text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 常驻中性灰，指针悬停才转危险色，避免一屏红图标 */
.del-btn {
  --el-button-size: 14px;
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  padding: 0;
  color: var(--cd-del-icon);
  font-size: 14px;
  transition: color 0.2s;

  &:hover:not(.is-disabled) {
    color: var(--cd-danger);
  }

  /* 同步中禁用：保持可见但不再响应悬停 */
  &.is-disabled,
  &.is-disabled:hover {
    color: var(--cd-del-icon);
  }
}

.empty-state {
  flex: 1 1 auto;
  justify-content: center;
}
</style>
