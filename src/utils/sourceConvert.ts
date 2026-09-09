import type { BookSource } from '../types/source'

/** 去掉 legado 模板里包裹 URL 的反引号 */
function clean(s: unknown): string {
  return typeof s === 'string' ? s.replaceAll('`', '').trim() : ''
}

/** 去掉 legado 规则的 @js:/@java: 后缀，只保留 CSS 选择器部分 */
function pureSelector(s: unknown): string {
  let out = clean(s)
  const jsIdx = out.indexOf('@js:')
  if (jsIdx >= 0) out = out.slice(0, jsIdx)
  const javaIdx = out.indexOf('@java:')
  if (javaIdx >= 0) out = out.slice(0, javaIdx)
  return out.trim()
}

/**
 * legado 搜索 data 模板 → 本格式表单模板
 * `{s: %s}` → "s={{key}}"；已含 %s 的裸模板直接替换占位符
 */
function convertData(data: unknown): string | undefined {
  const s = clean(data)
  if (!s) return undefined
  const inner = s.startsWith('{') && s.endsWith('}') ? s.slice(1, -1) : s
  const fields = inner.split(',').map((field) => field.trim()).filter(Boolean)
  if (fields.length) {
    const converted = fields.map((field) => {
      const separator = field.indexOf(':')
      if (separator < 0) return field.replaceAll('%s', '{{key}}')
      const key = field.slice(0, separator).trim()
      const value = field.slice(separator + 1).trim().replaceAll('%s', '{{key}}')
      return `${key}=${value}`
    })
    if (converted.some((field) => field.includes('{{key}}'))) return converted.join('&')
  }
  return s.includes('%s') ? s.replaceAll('%s', '{{key}}') : undefined
}

function isLegadoSource(obj: Record<string, unknown>): boolean {
  return 'toc' in obj || 'chapter' in obj
}

/** 「阅读」(legado) 格式 → 本应用 BookSource 格式 */
function convertLegadoSource(raw: Record<string, unknown>): BookSource | null {
  const name = clean(raw.name)
  const url = clean(raw.url)
  const search = raw.search as Record<string, unknown> | undefined
  const toc = raw.toc as Record<string, unknown> | undefined
  const chapter = raw.chapter as Record<string, unknown> | undefined
  if (!name || !url || !toc || !chapter) return null

  const chapterList = pureSelector(toc.item)
  const contentSelector = pureSelector(chapter.content)
  if (!chapterList || !contentSelector) return null

  // filterTag → 标签过滤；filterTxt → 文本/正则过滤
  const filterTag = clean(chapter.filterTag)
  const filterTxt = clean(chapter.filterTxt)
  const filter = filterTag
    ? filterTag.split(',').map((t) => t.trim()).filter(Boolean)
    : undefined
  const filterText = filterTxt
    ? filterTxt.split('|').map((t) => t.trim()).filter(Boolean)
    : undefined

  const bookName = pureSelector(search?.bookName)

  return {
    name,
    url,
    enabled: true,
    search: search
      ? {
          url: clean(search.url).replaceAll('%s', '{{key}}'),
          method: clean(search.method).toUpperCase() === 'POST' ? 'POST' : 'GET',
          data: convertData(search.data),
          bookList: pureSelector(search.result),
          name: bookName,
          author: pureSelector(search.author) || undefined,
          latestChapter: pureSelector(search.latestChapter) || undefined,
          // 详情链接一般就是书名所在的 <a>，附加 @href 提取
          detailUrl: bookName ? `${bookName}@href` : 'a@href',
        }
      : undefined,
    catalog: {
      chapterList,
      chapterName: '',
      chapterUrl: 'href',
      nextPage: pureSelector(toc.nextPage) || undefined,
    },
    content: {
      content: contentSelector,
      filter,
      filterText,
      nextPage: pureSelector(chapter.nextPage) || undefined,
    },
  }
}

/** 任意书源 JSON → BookSource：本应用格式原样校验，legado 格式自动转换 */
export function normalizeSource(raw: unknown): BookSource | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>

  if ('catalog' in obj && 'content' in obj) {
    const s = obj as unknown as BookSource
    if (s.name && s.url && s.catalog?.chapterList && s.content?.content) {
      return { ...s, enabled: s.enabled ?? true }
    }
    return null
  }
  if (isLegadoSource(obj)) return convertLegadoSource(obj)
  return null
}

export function normalizeSources(raw: unknown): BookSource[] {
  const list = Array.isArray(raw) ? raw : [raw]
  return list.map(normalizeSource).filter((source): source is BookSource => source !== null)
}
