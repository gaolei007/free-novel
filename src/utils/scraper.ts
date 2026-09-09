import type { BookSource } from '../types/source'
import type { BookItem, ChapterItem } from './messages'
import { assertSafeHttpUrl, isSafeHttpUrl } from './urlSafety'

interface FetchOptions {
  method?: 'GET' | 'POST'
  referer?: string
  /** POST 请求体，{{key}} 已替换为关键词 */
  body?: string
}

/** 抓取页面 HTML（background 拥有 <all_urls> 权限，可跨域） */
async function fetchHtml(url: string, options: FetchOptions = {}): Promise<string> {
  assertSafeHttpUrl(url)
  if (options.referer) assertSafeHttpUrl(options.referer, '来源地址')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const headers: Record<string, string> = { Referer: options.referer ?? url }
    const init: RequestInit = { method: options.method ?? 'GET', signal: controller.signal }
    if (options.body) {
      init.body = options.body
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
    }
    init.headers = headers
    const res = await fetch(url, init)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw new Error('请求超时')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

/** 取文本：rule 为 CSS 选择器时取匹配元素的 textContent，为空则取元素自身 */
function extractText(scope: Element, rule: string): string {
  const el = rule ? scope.querySelector(rule) : scope
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 取链接，规则支持三种写法：
 * - "a@href"：取 scope 下匹配 a 的元素的 href 属性
 * - "href"：取 scope 自身的 href 属性
 * - ".title"：取匹配元素，是 <a> 则取 href，否则向上找 <a>
 * 相对链接统一解析为绝对链接
 */
function extractUrl(scope: Element, rule: string, baseUrl: string): string {
  let el: Element | null = scope
  let attr: string | undefined

  const at = rule.indexOf('@')
  if (at >= 0) {
    el = scope.querySelector(rule.slice(0, at).trim())
    attr = rule.slice(at + 1).trim()
  } else if (/^[a-zA-Z][\w-]*$/.test(rule)) {
    // 纯属性名，从 scope 自身取
    attr = rule
  } else {
    el = scope.querySelector(rule)
  }

  let raw = ''
  if (attr && el) raw = el.getAttribute(attr) ?? ''
  else if (el) raw = el.getAttribute('href') ?? ''
  // 属性缺失时兜底取最近的 <a>
  if (!raw && el) raw = el.closest('a')?.getAttribute('href') ?? ''
  if (!raw) return ''
  try {
    const absolute = new URL(raw, baseUrl).toString()
    return isSafeHttpUrl(absolute) ? absolute : ''
  } catch {
    return ''
  }
}

/** 块级标签，正文转文本时在边界处换行 */
const BLOCK_TAGS = new Set(['P', 'DIV', 'BR', 'LI', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'])

/** 元素转纯文本，保留段落换行（SW 无布局引擎，innerText 不可用） */
function elementToText(root: Element): string {
  let out = ''
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? ''
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element
      if (BLOCK_TAGS.has(el.tagName)) out += '\n'
      el.childNodes.forEach(walk)
      if (BLOCK_TAGS.has(el.tagName)) out += '\n'
    }
  }
  root.childNodes.forEach(walk)
  return out
}

/** base64 → UTF-8 文本 */
function utf8Base64Decode(b64: string): string {
  const bin = atob(b64)
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

/**
 * 部分站点用样式表 `xxx>li:nth-child(n){display:none}` 隐藏列表里的
 * 广告/导航项（如 wxsy 目录页首尾的垃圾 li）。这里解析样式规则，
 * 把被隐藏的 li 从列表中删除，等价于 legado 书源里的那段 @js 清理。
 */
function removeHiddenListItems(doc: Document) {
  const cssText = [...doc.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n')
  const childHidden = new Map<string, Set<number>>()
  const lastHiddenCount = new Map<string, number>()
  // 前缀不能含 <（避免跨越 <style> 标签边界吞入 HTML）
  const re = /([^{}<]{0,200}?)\s*>\s*li:nth-(child|last-child)\((\d+)\)\s*\{[^}]*display\s*:\s*none[^}]*\}/g
  for (const m of cssText.matchAll(re)) {
    const prefix = m[1]?.trim() ?? ''
    if (m[2] === 'child') {
      const set = childHidden.get(prefix) ?? new Set<number>()
      set.add(Number(m[3]))
      childHidden.set(prefix, set)
    } else {
      lastHiddenCount.set(prefix, (lastHiddenCount.get(prefix) ?? 0) + 1)
    }
  }
  if (!childHidden.size && !lastHiddenCount.size) return

  const prefixes = new Set([...childHidden.keys(), ...lastHiddenCount.keys()])
  for (const prefix of prefixes) {
    let lists: NodeListOf<Element>
    try {
      lists = doc.querySelectorAll(prefix)
    } catch {
      continue
    }
    lists.forEach((list) => {
      const lis = [...list.children].filter((el) => el.tagName === 'LI')
      const hideFromStart = childHidden.get(prefix)
      const hideLastCount = lastHiddenCount.get(prefix) ?? 0
      lis.forEach((li, i) => {
        if (hideFromStart?.has(i + 1)) li.remove()
      })
      if (hideLastCount > 0) {
        lis.slice(Math.max(0, lis.length - hideLastCount)).forEach((li) => li.remove())
      }
    })
  }
}

/** 从页面提取章节列表（含隐藏 li 清理） */
function extractChapters(doc: Document, source: BookSource, baseUrl: string): ChapterItem[] {
  removeHiddenListItems(doc)
  return [...doc.querySelectorAll(source.catalog.chapterList)]
    .map((el) => ({
      name: extractText(el, source.catalog.chapterName),
      url: extractUrl(el, source.catalog.chapterUrl, baseUrl),
    }))
    .filter((item) => item.name && item.url)
}

function chapterNumber(name: string): number | null {
  const match = name.match(/第\s*(\d+)\s*章/)
  return match?.[1] ? Number(match[1]) : null
}

/** so-novel 部分目录分页顺序混乱，按章节号恢复从前往后的阅读顺序。 */
function sortChapters(chapters: ChapterItem[]): ChapterItem[] {
  return chapters
    .map((chapter, index) => ({ chapter, index, number: chapterNumber(chapter.name) }))
    .sort((a, b) => {
      if (a.number === null && b.number === null) return a.index - b.index
      if (a.number === null) return 1
      if (b.number === null) return -1
      return a.number - b.number || a.index - b.index
    })
    .map(({ chapter }) => chapter)
}

/** 按书源 RuleSearch 执行搜索 */
export async function searchBooks(source: BookSource, keyword: string): Promise<BookItem[]> {
  const rule = source.search
  if (!rule) throw new Error(`书源「${source.name}」未配置搜索规则`)
  const encoded = encodeURIComponent(keyword)
  const url = rule.url.replaceAll('{{key}}', encoded)
  const body =
    rule.method === 'POST'
      ? rule.data
        ? rule.data.replaceAll('{{key}}', encoded)
        : `key=${encoded}`
      : undefined
  const html = await fetchHtml(url, { method: rule.method, referer: source.url, body })
  const doc = parseHtml(html)
  return [...doc.querySelectorAll(rule.bookList)]
    .map((el) => ({
      name: extractText(el, rule.name),
      author: rule.author ? extractText(el, rule.author) : '',
      latestChapter: rule.latestChapter ? extractText(el, rule.latestChapter) : '',
      detailUrl: extractUrl(el, rule.detailUrl, url),
    }))
    .filter((item) => item.name && item.detailUrl)
}

/** 按书源 RuleCatalog 获取章节列表 */
export async function getCatalog(source: BookSource, detailUrl: string): Promise<ChapterItem[]> {
  let url = detailUrl
  let doc = parseHtml(await fetchHtml(url, { referer: source.url }))
  // 详情页不是目录页本身时，先按 catalogUrl 选择器跳转
  const catalogRule = source.detail?.catalogUrl
  if (catalogRule) {
    const catalogLink = extractUrl(doc.body, catalogRule, url)
    if (catalogLink && catalogLink !== url) {
      url = catalogLink
      doc = parseHtml(await fetchHtml(url, { referer: source.url }))
    }
  }
  let chapters = extractChapters(doc, source, url)
  // 兜底：详情页上找指向目录页的链接（常见 chapter/catalog 命名）
  if (!chapters.length) {
    const link =
      doc.querySelector('a[href*="chapter"]')?.getAttribute('href') ??
      doc.querySelector('a[href*="catalog"]')?.getAttribute('href')
    if (link) {
      try {
        const nextUrl = new URL(link, url).toString()
        if (!isSafeHttpUrl(nextUrl)) throw new Error('目录链接不是安全的 HTTP(S) 地址')
        url = nextUrl
        doc = parseHtml(await fetchHtml(url, { referer: source.url }))
        chapters = extractChapters(doc, source, url)
      } catch {
        // 忽略，返回已有结果
      }
    }
  }
  // 目录分页（select option / 分页链接的 value/href）
  const nextRule = source.catalog.nextPage
  if (nextRule) {
    const pages = new Set<string>()
    doc.querySelectorAll(nextRule).forEach((el) => {
      const raw = el.getAttribute('value') ?? el.getAttribute('href')
      if (!raw) return
      try {
        const abs = new URL(raw, url).toString()
        if (isSafeHttpUrl(abs) && abs !== url) pages.add(abs)
      } catch {
        // 忽略非法链接
      }
    })
    for (const page of [...pages].slice(0, 20)) {
      try {
        const pageDoc = parseHtml(await fetchHtml(page, { referer: source.url }))
        chapters.push(...extractChapters(pageDoc, source, page))
      } catch {
        // 单页失败不中断
      }
    }
  }
  // 按 url 去重
  const seen = new Set<string>()
  const unique: ChapterItem[] = []
  for (const c of chapters) {
    if (!seen.has(c.url)) {
      seen.add(c.url)
      unique.push(c)
    }
  }
  return sortChapters(unique)
}

function extractContentFromDocument(source: BookSource, doc: Document): string {
  const el = doc.querySelector(source.content.content)
  if (!el) throw new Error('未找到正文元素，请检查书源的 content.content 选择器')

  // 部分站点把正文 base64 编码后由脚本写入 DOM（如 qsbs.bb('...')），先取出来
  const encodedParts = [...el.innerHTML.matchAll(/qsbs\.bb\(\s*["']([A-Za-z0-9+/=]+)["']\s*\)/g)]
    .map((match) => match[1])
    .filter((part): part is string => Boolean(part))

  // 移除脚本与样式，避免 JS 代码混入正文
  el.querySelectorAll('script, style').forEach((node) => node.remove())

  // 有 base64 内容时，解码出的 HTML 作为正文根节点
  let root: Element = el
  if (encodedParts.length) {
    try {
      // 顶点小说可能把一章拆成多个 qsbs.bb() 片段，每个片段通常对应一个正文段落。
      // 必须全部解码后再合并，否则每章只会留下第一个段落。
      const decodedHtml = encodedParts.map(utf8Base64Decode).join('\n')
      root = parseHtml(decodedHtml).body
    } catch {
      root = el
    }
  }

  // 移除需要过滤的标签（书源 filter/filterTag）
  for (const filter of source.content.filter ?? []) {
    // 顶点小说 base64 解码后的正文包含 div/p 容器，过滤通用容器会误删整段正文。
    if (encodedParts.length && /^(div|p|script|style)$/i.test(filter.trim())) continue
    try {
      root.querySelectorAll(filter).forEach((node) => node.remove())
    } catch {
      // 非法选择器跳过
    }
  }

  let text = elementToText(root).replace(/\u00a0/g, ' ')

  // 文本级过滤（filter/filterText）：支持正则写法，如 `\(本章完\)`
  const textFilters = source.content.filterText ?? source.content.filter ?? []
  for (const filter of textFilters) {
    try {
      text = text.replace(new RegExp(filter, 'g'), '')
    } catch {
      text = text.split(filter).join('')
    }
  }

  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
}

function findNextContentPage(doc: Document, currentUrl: string, rule?: string): string {
  const isNextChapter = (text: string) => /下一章|下章/.test(text)
  const sameChapterPage = (nextUrl: string): boolean => {
    const currentMatch = currentUrl.match(/(\/read_\d+)(?:_\d+)?\.html(?:$|[?#])/)
    const nextMatch = nextUrl.match(/(\/read_\d+)(?:_\d+)?\.html(?:$|[?#])/)
    // 顶点小说：read_章节ID.html、read_章节ID_1.html、read_章节ID_2.html
    // 只有章节 ID 相同，才是同一章的下一页。
    return !currentMatch || !nextMatch || currentMatch[1] === nextMatch[1]
  }
  const fromRule = rule ? (() => {
    try {
      const element = doc.querySelector(rule)
      if (element) {
        const next = extractUrl(element, 'href', currentUrl)
        if (next && next !== currentUrl && sameChapterPage(next)) return next
      }
    } catch {
      // 书源选择器不兼容时使用通用规则兜底
    }
    return ''
  })() : ''
  if (fromRule && fromRule !== currentUrl) return fromRule

  const candidates = [...doc.querySelectorAll('a[href]')]
  for (const element of candidates) {
    const text = `${element.textContent ?? ''} ${element.getAttribute('title') ?? ''}`.replace(/\s+/g, '')
    // 顶点小说将同一章的分页链接也标记为“下一章”，由 URL 中的章节 ID 判断是否跨章。
    if (!/下一页|下页|继续阅读|阅读下一页|下一章|下章/.test(text)) continue
    const next = extractUrl(element, 'href', currentUrl)
    if (next && next !== currentUrl && sameChapterPage(next)) return next
  }
  return ''
}

/** 按书源 RuleContent 获取章节正文，支持正文分页、base64 混淆并过滤广告。 */
export async function getChapterContent(source: BookSource, chapterUrl: string): Promise<string> {
  const pages: string[] = []
  const visited = new Set<string>()
  let url = chapterUrl

  for (let index = 0; index < 20 && !visited.has(url); index += 1) {
    visited.add(url)
    const doc = parseHtml(await fetchHtml(url, { referer: source.url }))
    pages.push(extractContentFromDocument(source, doc))

    const nextUrl = findNextContentPage(doc, url, source.content.nextPage)
    if (!nextUrl || nextUrl === url || visited.has(nextUrl)) break
    url = nextUrl
  }

  return pages.filter(Boolean).join('\n')
}
