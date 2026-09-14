import type { BookSource } from '../types/source'
import type { BookItem, BookInfo, ChapterItem } from './messages'
import { assertSafeHttpUrl, isSafeHttpUrl } from './urlSafety'

interface FetchOptions {
  method?: 'GET' | 'POST'
  referer?: string
  /** POST 请求体，{{key}} 已替换为关键词 */
  body?: string
  /** 单次请求超时，默认 15s */
  timeout?: number
  /** 临时故障（超时 / 网络中断 / 429 / 5xx）的额外重试次数，默认 1 */
  retries?: number
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

class HttpError extends Error {
  status: number
  constructor(status: number) {
    super(`HTTP ${status}`)
    this.status = status
  }
}

/** 站点限流、CDN 抖动这类临时故障值得重试；403/404 之类的确定性拒绝没必要 */
function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) return error.status === 429 || error.status >= 500
  return true
}

async function fetchOnce(url: string, options: FetchOptions, timeout: number): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const headers: Record<string, string> = { Referer: options.referer ?? url }
    const init: RequestInit = { method: options.method ?? 'GET', signal: controller.signal }
    if (options.body) {
      init.body = options.body
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
    }
    init.headers = headers
    const res = await fetch(url, init)
    if (!res.ok) throw new HttpError(res.status)
    return await res.text()
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw new Error('请求超时')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 抓取页面 HTML（background 拥有 <all_urls> 权限，可跨域）。
 * 搜索时十几个书源同时打出去，站点限流/网络抖动导致的零星失败很常见，
 * 这里统一做退避重试，避免「第一次一片红、重搜一次就好了」。
 */
async function fetchHtml(url: string, options: FetchOptions = {}): Promise<string> {
  assertSafeHttpUrl(url)
  if (options.referer) assertSafeHttpUrl(options.referer, '来源地址')
  const retries = options.retries ?? 1
  const timeout = options.timeout ?? 15_000
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchOnce(url, options, timeout)
    } catch (e) {
      lastError = e
      if (attempt >= retries || !isRetryable(e)) throw e
      await sleep(800 * (attempt + 1))
    }
  }
  throw lastError
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

const CN_DIGITS: Record<string, number> = {
  '零': 0, '〇': 0, '○': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
}
const CN_UNITS: Record<string, number> = { '十': 10, '百': 100, '千': 1000 }
const CN_SECTIONS: Record<string, number> = { '万': 1e4, '亿': 1e8 }

/** 中文数字 → 阿拉伯数字，支持「一零二二」「一百零八」「一万二千」等写法 */
function chineseToNumber(text: string): number | null {
  if (!text) return null
  const chars = [...text]
  // 逐位写法：一零二二 → 1022
  if (chars.every((ch) => ch in CN_DIGITS)) {
    return chars.reduce((acc, ch) => acc * 10 + (CN_DIGITS[ch] ?? 0), 0)
  }
  // 带单位写法：一百零八 → 108
  let total = 0
  let section = 0
  let digit: number | null = null
  let matched = false
  for (const ch of chars) {
    if (ch in CN_DIGITS) {
      digit = CN_DIGITS[ch] ?? null
      matched = true
    } else if (ch in CN_UNITS) {
      section += (digit ?? 1) * (CN_UNITS[ch] ?? 0)
      digit = null
      matched = true
    } else if (ch in CN_SECTIONS) {
      total += (section + (digit ?? 0)) * (CN_SECTIONS[ch] ?? 0)
      section = 0
      digit = null
      matched = true
    } else {
      return null
    }
  }
  return matched ? total + section + (digit ?? 0) : null
}

/**
 * 从标题里取章节号，支持阿拉伯数字与中文数字。
 * 「章」可省略（站点偶尔出现「第一百一十三 知县撞大运」这种漏字的标题），
 * 也兼容「第X节」「第X回」。
 */
const CHAPTER_DIGITS = '[零〇○一二三四五六七八九十百千万两0-9]+'
/** 「第X章」「第X节」「第X回」 */
const NUMBERED_TITLE = new RegExp(`第\\s*(${CHAPTER_DIGITS})\\s*[章节回]`)
/** 「第X 标题」，站点偶尔漏掉「章」字 */
const NUMBERED_HEAD = new RegExp(`^\\s*第\\s*(${CHAPTER_DIGITS})\\s*(?=$|\\s)`)

/**
 * 从标题里取章节号，支持阿拉伯数字与中文数字。
 * 漏字的标题（如「第一百一十三 知县撞大运」）只认标题开头的写法，
 * 避免把「1月份第一波」这类公告误判成章节 1。
 */
function chapterNumber(name: string): number | null {
  const raw = NUMBERED_TITLE.exec(name)?.[1] ?? NUMBERED_HEAD.exec(name)?.[1]
  if (!raw) return null
  if (/^\d+$/.test(raw)) return Number(raw)
  // 「两」等价「二」
  return chineseToNumber(raw.replaceAll('两', '二'))
}

/** 不带序号但确实是正文的标题：序、楔子、番外、后记等 */
const EXTRA_TITLE = /^\s*(序|序言|自序|序章|楔子|引子|前言|番外|外传|尾声|后记|终章|附录)/

/**
 * 剔除目录里混进的作者单章、求票/请假/活动公告等非正文条目。
 * 只有当绝大多数标题都带序号时才剔除，避免误伤不用「第X章」格式的站点。
 */
function filterNonChapters(chapters: ChapterItem[]): ChapterItem[] {
  if (!chapters.length) return chapters
  const kept = chapters.filter((item) => chapterNumber(item.name) !== null || EXTRA_TITLE.test(item.name))
  return kept.length >= chapters.length * 0.8 ? kept : chapters
}

/**
 * 从详情页地址里取书籍 ID：优先用书源的详情页正则（legado book.url），
 * 否则退化成取路径末段的数字。
 */
function extractBookId(detailUrl: string, pattern?: string): string {
  if (pattern && pattern.length <= 200) {
    try {
      const matched = new RegExp(pattern).exec(detailUrl)
      const id = matched?.[1]?.trim()
      if (id) return id
    } catch {
      // 正则非法时走兜底
    }
  }
  return detailUrl.match(/\/(\d+)(?=[/?#]|$)/)?.[1] ?? ''
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
  // 搜索是所有书源同时打出去，单站超时压短一点、重试给足，整体体感更稳
  const html = await fetchHtml(url, { method: rule.method, referer: source.url, body, timeout: 10_000, retries: 2 })
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

/** 从详情页 <title> 里兜底抠书名：多为「书名最新章节_书名作者_…」这类拼接 */
function nameFromTitle(title: string): string {
  const first = title.split(/[_|｜\-—]/)[0]?.trim() ?? ''
  return first.replace(/(最新章节|全文阅读|免费阅读|最新章节列表|小说)$/g, '').trim()
}

/**
 * 读详情页里的书名/作者，供「按链接下载」使用。
 * 优先 og:novel:book_name 这类结构化 meta，其次 h1，最后才退到 title。
 */
export async function getBookInfo(source: BookSource, detailUrl: string): Promise<BookInfo> {
  const html = await fetchHtml(detailUrl, { referer: source.url, retries: 1 })
  const doc = parseHtml(html)
  const meta = (key: string) =>
    doc.querySelector(`meta[property="og:novel:${key}"]`)?.getAttribute('content')?.trim() ?? ''
  const h1 = (doc.querySelector('h1')?.textContent ?? '').replace(/\s+/g, ' ').trim()
  const title = (doc.querySelector('title')?.textContent ?? '').trim()
  return {
    name: meta('book_name') || h1 || nameFromTitle(title),
    author: meta('author'),
  }
}

/** 按书源 RuleCatalog 获取章节列表 */
export async function getCatalog(source: BookSource, detailUrl: string): Promise<ChapterItem[]> {
  let url = detailUrl
  let doc = parseHtml(await fetchHtml(url, { referer: source.url }))

  // 书源声明了独立目录页（legado toc.url）时优先跳转。
  // 顶点小说等站点的详情页只列出最新若干章、且没有分页入口，
  // 停在详情页会只拿到一百来章。
  const templateUrl = source.catalog.urlTemplate
  if (templateUrl?.includes('%s')) {
    const bookId = extractBookId(detailUrl, source.detail?.urlPattern)
    if (bookId) {
      const target = templateUrl.replaceAll('%s', bookId)
      if (isSafeHttpUrl(target) && target !== url) {
        url = target
        doc = parseHtml(await fetchHtml(url, { referer: source.url }))
        return collectCatalog(source, url, doc)
      }
    }
  }

  // 详情页不是目录页本身时，先按 catalogUrl 选择器跳转
  const catalogRule = source.detail?.catalogUrl
  if (catalogRule) {
    const catalogLink = extractUrl(doc.body, catalogRule, url)
    if (catalogLink && catalogLink !== url) {
      url = catalogLink
      doc = parseHtml(await fetchHtml(url, { referer: source.url }))
    }
  }
  return collectCatalog(source, url, doc)
}

/** 从目录页出发：抓当前页 + 分页，返回去重排序后的章节列表 */
async function collectCatalog(source: BookSource, startUrl: string, startDoc: Document): Promise<ChapterItem[]> {
  let url = startUrl
  let doc = startDoc
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
  const pages = new Set<string>()
  if (nextRule) {
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
    // 长篇动辄几十页目录，上限放宽到 50 页（约 5000 章）
    for (const page of [...pages].slice(0, 50)) {
      try {
        const pageDoc = parseHtml(await fetchHtml(page, { referer: source.url }))
        chapters.push(...extractChapters(pageDoc, source, page))
      } catch {
        // 单页失败不中断
      }
    }
  }
  // 兜底：页面上没有任何分页入口时（如顶点小说详情页），从源码里找
  // chapter_1.html 形式的完整目录页链接再抓一遍。旧书源没有目录页
  // 模板字段时靠它拿到全本，而不是只拿详情页上的最新几章。
  if (!pages.size) {
    const fallback = findChapterCatalogLink(doc, url)
    if (fallback) {
      try {
        const fallbackDoc = parseHtml(await fetchHtml(fallback, { referer: source.url }))
        chapters.push(...(await collectCatalog(source, fallback, fallbackDoc)))
      } catch {
        // 兜底失败就维持已有结果
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
  return sortChapters(filterNonChapters(unique))
}

/** 从页面源码（含内联脚本）里找 chapter_1.html 形式的完整目录页链接 */
function findChapterCatalogLink(doc: Document, baseUrl: string): string {
  for (const match of doc.documentElement.outerHTML.matchAll(/["']([^"']*\/chapter_1\.html(?:\?[^"']*)?)["']/g)) {
    try {
      const abs = new URL(match[1] ?? '', baseUrl).toString()
      if (isSafeHttpUrl(abs) && abs !== baseUrl) return abs
    } catch {
      // 非法链接继续找下一个
    }
  }
  return ''
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

  text = cleanContentLines(text)
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
}

/** 站点通用的整行广告，书源的 filterText 通常覆盖不全 */
const NOISE_LINE_PATTERNS = [
  /正在手打中/,
  /内容更新后，请重新刷新页面/,
  /^相邻推荐[:：]/,
  /请勿开启浏览器阅读模式/,
  /本站小说均为.{0,10}用户上传/,
]

/** 章节首段植入的推荐话术：「推荐各位书友阅读：书名第X章标题（..）」 */
const PROMO_PREFIX = /^推荐各位书友阅读：[\s\S]{0,80}?[（(]\s*\.\.\s*[）)]?/

/**
 * 清理站点广告行与章节首段的推荐话术。
 * 只删整行已知模板和明确的行首选推语，不动正文，对所有书源生效。
 */
function cleanContentLines(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(PROMO_PREFIX, '').trim())
    .filter((line) => !NOISE_LINE_PATTERNS.some((pattern) => pattern.test(line)))
    .join('\n')
}

/**
 * 章节标识：抹掉 `_1` / `-2` 这类分页后缀。
 * 顶点小说 `read_161670832_1.html` → `read_161670832`，与本章首页同一标识；
 * 而 `read_161670832.html` 自身不带分页后缀，标识保持完整。
 */
function chapterToken(url: string): string {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? ''
    const name = last.replace(/\.[a-z0-9]+$/i, '')
    // 只有「已有 _数字 前缀、再跟一个 _数字」才认定为分页后缀，
    // 否则会把章节 ID 本身（read_161670832）误当成后缀剥掉
    return (name.match(/^(.*[_-]\d+)[_-]\d+$/)?.[1] ?? name).toLowerCase()
  } catch {
    return ''
  }
}

/**
 * 候选地址是否与本章首页属于同一章。
 * 只有双方都带「够长的数字」（真章节 ID 那样）时才敢下判断；
 * 像 page1/page2 这种短数字分不清是页码还是章节，一律放行，避免误伤其他站点。
 */
function isSameChapter(anchorUrl: string, candidate: string): boolean {
  const anchor = chapterToken(anchorUrl)
  const token = chapterToken(candidate)
  if (!/\d{4,}/.test(anchor) || !/\d{4,}/.test(token)) return true
  return anchor === token
}

/** 必须能「确认」同章才返回 true，判不出来就算 false —— 用于语义含糊的候选链接 */
function isConfirmedSameChapter(anchorUrl: string, candidate: string): boolean {
  const anchor = chapterToken(anchorUrl)
  const token = chapterToken(candidate)
  return /\d{4,}/.test(anchor) && /\d{4,}/.test(token) && anchor === token
}

/**
 * 找当前正文页的下一页。
 *
 * anchorUrl 是本章第一页的地址，所有候选页都必须与它同章——这是硬约束：
 * 站点普遍把「同章分页」和「下一章」混着标（顶点小说下一章链到 `read_ID_1.html`），
 * 一旦放开就会顺着链接把后面几十章全混进本章，出来一章几万字、整本十几倍的垃圾。
 */
function findNextContentPage(doc: Document, currentUrl: string, rule: string | undefined, anchorUrl: string): string {
  const accept = (candidate: string) => Boolean(candidate) && candidate !== currentUrl && isSameChapter(anchorUrl, candidate)

  if (rule) {
    try {
      const element = doc.querySelector(rule)
      const next = element ? extractUrl(element, 'href', currentUrl) : ''
      if (accept(next)) return next
    } catch {
      // 书源选择器不兼容时使用通用规则兜底
    }
  }

  // 通用兜底：明确的翻页文案（下一页/下页/继续阅读）按宽松规则放行；
  // 「下一章/下章」语义含糊——顶点小说用它标同章分页，多数站点就是字面意思，
  // 只有能确认同章时才跟，否则宁可不跟。
  for (const element of doc.querySelectorAll('a[href]')) {
    const text = `${element.textContent ?? ''} ${element.getAttribute('title') ?? ''}`.replace(/\s+/g, '')
    const isPaging = /下一页|下页|继续阅读|阅读下一页/.test(text)
    const maybeNextChapter = !isPaging && /下一章|下章/.test(text)
    if (!isPaging && !maybeNextChapter) continue
    const next = extractUrl(element, 'href', currentUrl)
    if (!next || next === currentUrl) continue
    if (isPaging ? isSameChapter(anchorUrl, next) : isConfirmedSameChapter(anchorUrl, next)) return next
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
    // 正文不在这里重试：上游 downloader 已有退避重试与 60s 看门狗，叠加会把看门狗撑爆
    const doc = parseHtml(await fetchHtml(url, { referer: source.url, retries: 0 }))
    pages.push(extractContentFromDocument(source, doc))

    const nextUrl = findNextContentPage(doc, url, source.content.nextPage, chapterUrl)
    if (!nextUrl || nextUrl === url || visited.has(nextUrl)) break
    url = nextUrl
  }

  return pages.filter(Boolean).join('\n')
}
