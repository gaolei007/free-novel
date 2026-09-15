import { readonly, ref } from 'vue'

export type ThemeMode = 'light' | 'dark'

const STORAGE_KEY = 'themeMode'

/** 系统偏好，作为用户没手动选过时的默认值 */
const media = window.matchMedia('(prefers-color-scheme: dark)')

const mode = ref<ThemeMode>(media.matches ? 'dark' : 'light')

/** 用户手动切换过之后就固定下来，不再让系统偏好覆盖 */
let pinned = false

/** 主题对外只读，避免组件里绕过 toggleTheme 直接改状态 */
export const themeMode = readonly(mode)

/**
 * Element Plus 的暗色变量挂在 html.dark 上，
 * 所以切换主题就是切这个类，组件内不需要写任何暗色分支。
 */
function apply(next: ThemeMode) {
  mode.value = next
  document.documentElement.classList.toggle('dark', next === 'dark')
}

/** 点顶部切换按钮：翻转当前主题并落盘 */
export function toggleTheme() {
  pinned = true
  apply(mode.value === 'dark' ? 'light' : 'dark')
  void browser.storage.local.set({ [STORAGE_KEY]: mode.value })
}

/**
 * 首次渲染前调用：存储里有用户选择就用它，否则跟随系统；
 * 之后系统主题变化时，只有没被用户固定过才继续跟随。
 */
export async function initTheme(): Promise<void> {
  let stored: unknown
  try {
    stored = (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY]
  } catch {
    // 读不到存储（首次安装等）就退回系统偏好
    stored = undefined
  }

  if (stored === 'light' || stored === 'dark') {
    pinned = true
    apply(stored)
  } else {
    apply(media.matches ? 'dark' : 'light')
  }

  media.addEventListener('change', () => {
    if (!pinned) apply(media.matches ? 'dark' : 'light')
  })
}
