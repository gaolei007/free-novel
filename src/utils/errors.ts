/**
 * 统一把未知错误转成可读文本。
 * 扩展里 Error 经过 runtime.sendMessage 消息通道后常退化成普通对象（甚至空对象），
 * 直接读 error.message 大概率拿不到内容，必须多形态兜底。
 */
function toText(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value.trim()
  if (value instanceof Error) return (value.message || value.name).trim()
  if (typeof value === 'object') {
    const message = (value as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message.trim()
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

/**
 * 去掉消息通道给错误加的包装前缀。
 * 错误在 offscreen → background → sidepanel 上每过一跳就会被套一层
 * 「Uncaught Error: 」，两层叠起来就成了「Uncaught Error: Uncaught Error: HTTP 404」。
 */
function stripWrapper(text: string): string {
  let out = text
  for (let i = 0; i < 5; i += 1) {
    const next = out.replace(/^\s*Uncaught\s+(?:TypeError|Error|DOMException)?\s*:?\s*/i, '').trim()
    if (next === out) break
    out = next
  }
  return out
}

const HTTP_HINTS: Record<number, string> = {
  400: '请求参数不被站点接受',
  401: '站点要求登录',
  403: '站点拒绝访问（可能被限流或触发了防爬）',
  404: '地址不存在（书源可能已失效或站点换了域名）',
  429: '请求过于频繁，已被站点限流',
}

/** 把裸错误码补成人话，方便在弹窗里直接判断该换源还是该等一会儿 */
function describeFriendly(text: string): string {
  const http = /^HTTP\s+(\d{3})$/.exec(text)
  if (http) {
    const status = Number(http[1])
    const hint = HTTP_HINTS[status] ?? (status >= 500 ? '站点服务器异常（稍后重试）' : '请求被站点拒绝')
    return `HTTP ${status}：${hint}`
  }
  if (/Failed to fetch|NetworkError|net::ERR_|network error/i.test(text)) {
    return '无法连接站点（域名失效、网络不通，或站点为 http 被浏览器安全策略拦截）'
  }
  return text
}

export function describeError(value: unknown): string {
  return describeFriendly(stripWrapper(toText(value)))
}
