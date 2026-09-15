<template>
  <div class="sidepanel">
    <!-- 品牌 + 分段控件 + 主题切换同处一行：品牌与切换贴齐两端，分段控件占满中间 -->
    <div class="tab-row">
      <img class="brand-icon" :src="brandLogo" alt="" aria-hidden="true" draggable="false" />

      <!-- 分段控件：角标常驻，状态可见性不依赖当前选中项 -->
      <el-segmented v-model="activeTab" :options="tabOptions" block class="tab-bar">
        <template #default="{ item }">
          <span class="tab-label">
            <span>{{ optionLabel(item) }}</span>
            <span v-if="showBadge(item)" class="tab-badge">{{ badgeText }}</span>
          </span>
        </template>
      </el-segmented>

      <!-- 亮色显月亮（点了进暗色），暗色显太阳，是状态指示而不是第四段 -->
      <button
        class="theme-toggle"
        type="button"
        :title="themeToggleHint"
        :aria-label="themeToggleHint"
        @click="toggleTheme"
      >
        <el-icon v-if="isDark"><Sunny /></el-icon>
        <el-icon v-else><Moon /></el-icon>
      </button>
    </div>

    <div class="panel-stack">
      <SearchList v-show="activeTab === 'search'" />
      <DownloadRecords v-show="activeTab === 'downloads'" />
      <SourceConfig v-show="activeTab === 'sources'" />
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Moon, Sunny } from '@element-plus/icons-vue'
import SearchList from './components/SearchList.vue'
import DownloadRecords from './components/DownloadRecords.vue'
import SourceConfig from './components/SourceConfig.vue'
import {
  STORAGE_KEYS,
  countIncompleteRecords,
  loadRecords,
  type DownloadRecord,
} from '../../utils/storage'
import { syncSoNovelSources } from '../../utils/sourceSync'
import { themeMode, toggleTheme } from '../../utils/theme'

// 书源规则更新较频繁（站点改版要跟着改选择器），超过 12 小时就在打开侧边栏时静默同步
const AUTO_SYNC_INTERVAL = 12 * 60 * 60 * 1000

interface TabOption {
  label: string
  value: string
}

const tabOptions: TabOption[] = [
  { label: '搜索小说', value: 'search' },
  { label: '下载记录', value: 'downloads' },
  { label: '同步书源', value: 'sources' },
]

const activeTab = ref('search')
const incompleteCount = ref(0)
const badgeText = computed(() => (incompleteCount.value > 99 ? '99+' : String(incompleteCount.value)))

const isDark = computed(() => themeMode.value === 'dark')
const themeToggleHint = computed(() => (isDark.value ? '切换到日间模式' : '切换到夜间模式'))

// public/ 下的资源会原样拷到扩展根目录，用运行时路径引用即可；
// 写成变量而不是模板里的 src 字面量，是为了绕开打包器对 <img src> 的静态解析
const brandLogo = '/wxt.svg'

/** el-segmented 的 options 既可能是字符串也可能是对象，取显示文案 */
function optionLabel(item: unknown): string {
  if (typeof item === 'string' || typeof item === 'number') return String(item)
  return (item as TabOption | null)?.label ?? ''
}

/** 只有「下载记录」带角标，且未下载完的记录数 > 0 才显示 */
function showBadge(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false
  return (item as TabOption).value === 'downloads' && incompleteCount.value > 0
}

const onStorageChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
  const change = changes[STORAGE_KEYS.records]
  if (area !== 'local' || !change) return
  incompleteCount.value = countIncompleteRecords(
    Array.isArray(change.newValue) ? (change.newValue as DownloadRecord[]) : [],
  )
}

onMounted(async () => {
  incompleteCount.value = countIncompleteRecords(await loadRecords())
  browser.storage.onChanged.addListener(onStorageChanged)
  warmUpScraper()
  void autoSyncSources()
})

/** 预热离屏文档，避免第一次搜索时冷启动导致的整片书源失败 */
function warmUpScraper() {
  browser.runtime.sendMessage({ type: 'warmup' }).catch(() => {})
}

onBeforeUnmount(() => browser.storage.onChanged.removeListener(onStorageChanged))

/** 静默同步远程书源，失败不打扰用户（搜索页仍能用本地缓存的书源） */
async function autoSyncSources() {
  try {
    const { lastSourceSyncAt } = await browser.storage.local.get('lastSourceSyncAt')
    if (typeof lastSourceSyncAt === 'number' && Date.now() - lastSourceSyncAt < AUTO_SYNC_INTERVAL) return
    await syncSoNovelSources()
    await browser.storage.local.set({ lastSourceSyncAt: Date.now() })
  } catch {
    // 网络不通等原因导致失败时保持静默
  }
}
</script>

<style lang="scss">
/* ============================================================
   设计令牌 —— 与 UI 稿件逐值对应
   切主题只需在 html 上挂 / 摘 dark 类（main.ts 跟随系统偏好）
   ============================================================ */
:root {
  --cd-bg: #f2f3f5;
  --cd-panel: #ffffff;
  --cd-divider: #e4e7ed;
  --cd-input-border: #dcdfe6;
  --cd-card-border: #ebeef5;
  --cd-text-primary: #303133;
  --cd-text-regular: #606266;
  --cd-text-secondary: #909399;
  --cd-icon-weak: #c0c4cc;
  --cd-placeholder: #a8abb2;
  --cd-primary: #409eff;
  --cd-primary-hover: #66b1ff;
  --cd-primary-soft: #ecf5ff;
  --cd-primary-soft-border: #a0cfff;
  --cd-tag-bg: #ecf5ff;
  --cd-tag-ring: transparent;
  --cd-warn-bg: #fdf6ec;
  --cd-warn: #e6a23c;
  --cd-danger: #f56c6c;
  --cd-success: #67c23a;
  --cd-track: #ebeef5;
  --cd-del-icon: #c0c4cc;
  /* 弹窗跟着卡片底色走，避免默认 bg 与稿件不一致 */
  --el-dialog-bg-color: var(--cd-panel);
}

html.dark {
  --cd-bg: #0a0a0a;
  --cd-panel: #1d1e1f;
  --cd-divider: #2c2c2e;
  --cd-input-border: #414243;
  --cd-card-border: #363637;
  --cd-text-primary: #e5eaf3;
  --cd-text-regular: #cfd3dc;
  --cd-text-secondary: #a3a6ad;
  --cd-icon-weak: #4c4d4f;
  --cd-placeholder: #a8abb2;
  --cd-primary: #409eff;
  --cd-primary-hover: #66b1ff;
  --cd-primary-soft: #18222c;
  --cd-primary-soft-border: #2c4a6b;
  /* 暗色下 #18222c 与卡片 #1d1e1f 对比仅 1.03，等于融底，故提亮并加一圈描边 */
  --cd-tag-bg: #24405f;
  --cd-tag-ring: #2c4a6b;
  --cd-warn-bg: #2b1d11;
  --cd-warn: #e6a23c;
  --cd-danger: #f56c6c;
  --cd-success: #67c23a;
  --cd-track: #363637;
  /* 删除图标不能用 --cd-icon-weak（暗色下是 #4c4d4f）叠透明度，会和卡片底融在一起 */
  --cd-del-icon: #8a8f99;
}

html,
body,
#app {
  height: 100%;
  margin: 0;
  min-width: 360px;
}

body {
  background: var(--cd-bg);
  color: var(--cd-text-primary);
  font-family: "Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
    -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  -webkit-font-smoothing: antialiased;
}
</style>

<style lang="scss" scoped>
.sidepanel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  padding: 12px;
  box-sizing: border-box;
  background: var(--cd-bg);
}

/* ---------- 顶部一行：品牌 + 分段控件 + 主题切换 ---------- */
.tab-row {
  display: flex;
  flex: 0 0 38px;
  align-items: center;
  gap: 14px;
}

/* 品牌只留 logo，和右端主题切换各自贴齐这一行两端 */
.brand-icon {
  display: block;
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
}

.theme-toggle {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--cd-text-regular);
  cursor: pointer;
  transition: color 0.2s;

  &:hover {
    color: var(--cd-primary);
  }
}

/* ---------- 分段控件（el-segmented） ---------- */
.tab-bar {
  flex: 1 1 0;
  min-width: 0;
  height: 38px;
  min-height: 38px;
  padding: 3px;
  border-radius: 8px;
  background: var(--cd-panel);
  box-shadow: inset 0 0 0 1px var(--cd-divider);
  font-size: 12px;

  // 用组件自身的 CSS 变量对接设计令牌，避免和内部类名硬碰
  --el-segmented-bg-color: transparent;
  --el-segmented-padding: 0;
  --el-segmented-color: var(--cd-text-regular);
  --el-segmented-item-selected-bg-color: var(--cd-primary);
  --el-segmented-item-selected-color: #fff;
  --el-segmented-item-hover-color: var(--cd-primary);
  --el-segmented-item-hover-bg-color: transparent;
  --el-segmented-item-active-bg-color: transparent;

  :deep(.el-segmented__item) {
    justify-content: center;
    gap: 4px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 400;
    padding: 0;
  }

  :deep(.el-segmented__item.is-selected) {
    font-weight: 500;
  }

  :deep(.el-segmented__item-selected) {
    border-radius: 6px;
  }
}

.tab-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.tab-badge {
  display: inline-flex;
  flex: 0 0 16px;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--cd-danger);
  color: #fff;
  font-size: 10px;
  line-height: 1;
  font-weight: 500;
  box-sizing: border-box;
}

/* ---------- 面板容器 ---------- */
.panel-stack {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;

  > * {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
  }
}
</style>
