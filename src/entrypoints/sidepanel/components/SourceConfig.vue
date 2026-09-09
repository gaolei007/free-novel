<template>
  <div class="source-config">
    <section class="intro-card">
      <div class="sync-info">
        <div class="status-row"><span>本地书源</span><strong>{{ sources.length }} 个</strong></div>
        <div v-if="lastSyncAt" class="status-row secondary"><span>最近同步</span><span>{{ formatTime(lastSyncAt) }}</span></div>
      </div>
      <el-button type="primary" :loading="syncing" @click="handleSync">
        <el-icon><Refresh /></el-icon>{{ syncing ? '同步中…' : '立即同步' }}
      </el-button>
    </section>
    <el-alert v-if="errorMessage" :title="errorMessage" type="error" show-icon :closable="false" />
    <el-empty v-if="!sources.length" description="暂无本地书源，请先同步" :image-size="64" />
    <section v-else class="source-list">
      <div v-for="source in sources" :key="source.url" class="source-item">
        <div class="source-dot" />
        <div class="source-info"><div class="source-name">{{ source.name }}</div><div class="source-url">{{ source.url }}</div></div>
      </div>
    </section>
  </div>
</template>

<script lang="ts" setup>
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import type { BookSource } from '../../../types/source'
import { loadSources } from '../../../utils/storage'
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

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(timestamp)
}
</script>

<style lang="scss" scoped>
.source-config { padding: 16px; }
.intro-card { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px; border-radius: 20px; }
.sync-info { min-width: 0; }
.eyebrow { color: var(--el-color-primary); font-size: 12px; font-weight: 700; letter-spacing: .08em; }
.status-row { display: flex; justify-content: space-between; gap: 12px; }
.status-row { margin-top: 8px; }
.secondary { color: var(--el-text-color-secondary); font-size: 12px; }
.source-list { margin-top: 14px; }
.source-item { display: flex; gap: 10px; padding: 12px 4px; border-bottom: 1px solid var(--el-border-color-lighter); }
.source-dot { width: 8px; height: 8px; margin-top: 5px; flex: 0 0 auto; border-radius: 50%; background: var(--el-color-success); }
.source-info { min-width: 0; }
.source-name { font-weight: 600; }
.source-url { margin-top: 3px; overflow: hidden; color: var(--el-text-color-secondary); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.el-alert { margin-top: 12px; }
</style>
