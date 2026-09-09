<template>
  <div class="sidepanel">
    <el-tabs v-model="activeTab" class="sidepanel-tabs">
      <el-tab-pane label="搜索小说" name="search" class="search-pane">
        <SearchList />
      </el-tab-pane>
      <el-tab-pane name="downloads">
        <template #label>
          <span class="download-tab-label">下载记录<el-badge v-if="recordCount" :value="Math.min(recordCount, 99)" /></span>
        </template>
        <DownloadRecords />
      </el-tab-pane>
      <el-tab-pane label="同步书源" name="sources">
        <SourceConfig />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script lang="ts" setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import SearchList from './components/SearchList.vue'
import DownloadRecords from './components/DownloadRecords.vue'
import SourceConfig from './components/SourceConfig.vue'
import { STORAGE_KEYS, loadRecords } from '../../utils/storage'

const activeTab = ref('search')
const recordCount = ref(0)

const onStorageChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
  const change = changes[STORAGE_KEYS.records]
  if (area !== 'local' || !change) return
  recordCount.value = Array.isArray(change.newValue) ? change.newValue.length : 0
}

onMounted(async () => {
  recordCount.value = (await loadRecords()).length
  browser.storage.onChanged.addListener(onStorageChanged)
})

onBeforeUnmount(() => browser.storage.onChanged.removeListener(onStorageChanged))
</script>

<style lang="scss">
html,
body,
#app {
  height: 100%;
  margin: 0;
  min-width: 360px;
}

// 背景与文字色用 Element Plus 变量，自动跟随暗色/亮色
body {
  background: var(--el-bg-color);
  color: var(--el-text-color-primary);
  font-family: Inter, Roboto, "Noto Sans SC", system-ui, sans-serif;
}
</style>

<style lang="scss" scoped>
.sidepanel {
  display: flex;
  flex-direction: column;
  height: 100%;

  .sidepanel-tabs {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;

    // 头部：去掉默认底边线，留出外边距
    :deep(.el-tabs__header) {
      margin: 0;
      padding: 8px 10px;
      border-bottom: none;
    }

    :deep(.download-tab-label) {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    :deep(.download-tab-label .el-badge__content) {
      position: static;
      transform: none;
      border: 0;
    }

    // 整条 nav 变成深色圆角容器
    :deep(.el-tabs__nav-wrap) {
      padding: 4px;
      background: var(--el-fill-color-dark);
      border-radius: 10px;

      // 去掉默认底部分隔线
      &::after {
        display: none;
      }
    }

    // 关键：nav 撑满整行，每个 item 平分宽度（不管几个 tab）
    :deep(.el-tabs__nav-scroll) {
      width: 100%;
    }

    :deep(.el-tabs__nav) {
      display: flex;
      width: 100%;
    }

    :deep(.el-tabs__item) {
      flex: 1;
      height: 32px;
      line-height: 32px;
      padding: 0;
      text-align: center;
      border-radius: 8px;
      color: var(--el-text-color-regular);
      transition:
        background-color 0.2s,
        color 0.2s;

      &:hover:not(.is-active) {
        color: var(--el-text-color-primary);
      }

      // 选中项：蓝色圆角块 + 白字
      &.is-active {
        background: var(--el-color-primary);
        color: #fff;
      }
    }

    // 隐藏默认的底部活动指示条
    :deep(.el-tabs__active-bar) {
      display: none;
    }

    :deep(.el-tabs__content) {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow: hidden;
    }

    :deep(.el-tab-pane) {
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      height: 100%;
      min-height: 0;
    }

    :deep(.search-pane) {
      overflow: hidden;
    }

    :deep(.el-tab-pane:not(.search-pane)) {
      overflow-y: auto;
    }
  }
}
</style>
