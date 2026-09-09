<template>
  <div class="download-records">
    <div class="toolbar">
      <span class="count">共 {{ records.length }} 条记录</span>
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
          <div v-if="record.status === 'failed'" class="record-error">下载失败：{{ record.errorMessage || '未知错误' }}</div>
        </div>
      </div>
    </el-scrollbar>
  </div>
</template>

<script lang="ts" setup>
import { onMounted, onBeforeUnmount, ref } from 'vue'
import {
  STORAGE_KEYS,
  clearRecords,
  loadRecords,
  type DownloadRecord,
} from '../../../utils/storage'

const records = ref<DownloadRecord[]>([])

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
})

onBeforeUnmount(() => {
  browser.storage.onChanged.removeListener(onStorageChanged)
})

function handleClear() {
  void clearRecords().then(() => (records.value = []))
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString()
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

  :deep {
    .el-progress {
      width: 100%;
      margin-top: 8px;
      &__text {
        min-width: 0;
      }
    }
  }

  .record-error {
    margin-top: 6px;
    color: var(--el-color-danger);
    font-size: 12px;
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
