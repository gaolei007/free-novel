import type { BackgroundMessage, OffscreenMessage, ScrapeRequest } from '../utils/messages'

const OFFSCREEN_PATH = 'offscreen.html'

function offscreenUrl() {
  return browser.runtime.getURL(`/${OFFSCREEN_PATH}`)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function isOffscreenAlive() {
  try {
    const contexts = await browser.runtime.getContexts({
      contextTypes: [browser.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [offscreenUrl()],
    })
    return contexts.length > 0
  } catch {
    return false
  }
}

/**
 * 创建离屏文档。搜索会同时发起十几个请求，若每个都走一遍「查不到 → createDocument」，
 * 并发调用会互相踩脚（Chrome 只允许存在一个离屏文档，多出来的调用直接抛错），
 * 表现就是「第一次搜一大片失败，再点一次就正常」。
 * 用一个模块级 Promise 把并发调用收敛成一次，失败则不缓存以便下次重试。
 */
let offscreenReady: Promise<void> | null = null

function ensureOffscreenDocument(): Promise<void> {
  if (!offscreenReady) {
    offscreenReady = (async () => {
      if (await isOffscreenAlive()) return
      try {
        await browser.offscreen.createDocument({
          url: OFFSCREEN_PATH,
          reasons: [browser.offscreen.Reason.DOM_PARSER],
          justification: '解析小说书源返回的 HTML 页面',
        })
      } catch (error) {
        // 并发下别处已创建成功 / 老版本 Chrome 重复创建，都按成功处理
        const text = error instanceof Error ? error.message : String(error ?? '')
        if (/single offscreen|already exists|only one offscreen/i.test(text)) return
        if (!(await isOffscreenAlive())) throw error
      }
    })().catch((error) => {
      offscreenReady = null
      throw error
    })
  }
  return offscreenReady
}

/** 离屏文档刚创建时脚本还没注册监听，消息会撞上「Receiving end does not exist」，重试等它就绪 */
function isNoReceiverError(error: unknown) {
  const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error ?? '')
  return /Receiving end does not exist|Could not establish connection|message port closed|Extension context invalidated/i.test(message)
}

async function sendToOffscreen(message: ScrapeRequest, attempts = 4): Promise<unknown> {
  const relayed: OffscreenMessage = { ...message, relay: true }
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await ensureOffscreenDocument()
      return await browser.runtime.sendMessage(relayed)
    } catch (error) {
      lastError = error
      if (!isNoReceiverError(error) || attempt === attempts - 1) throw error
      offscreenReady = null
      await sleep(120 * (attempt + 1))
    }
  }
  throw lastError
}

function runScraper(message: ScrapeRequest) {
  return sendToOffscreen(message)
}

export default defineBackground(() => {
  console.log('Hello background!', { id: browser.runtime.id })

  // 扩展刚装好/刚重载时先把离屏文档建起来，首次搜索不用等冷启动
  browser.runtime.onInstalled.addListener(() => {
    ensureOffscreenDocument().catch(() => {})
  })

  // 点击扩展图标打开侧边栏（必须在用户手势回调中调用）
  browser.action.onClicked.addListener((tab) => {
    if (tab.windowId != null) {
      browser.sidePanel.open({ windowId: tab.windowId })
    }
  })

  // 消息路由：处理侧边栏的抓取请求
  browser.runtime.onMessage.addListener((message: BackgroundMessage) => {
    switch (message.type) {
      case 'warmup':
        return ensureOffscreenDocument().then(() => true)
      case 'search':
      case 'getCatalog':
      case 'getChapterContent':
      case 'getBookInfo':
        return runScraper(message)
    }
  })
})
