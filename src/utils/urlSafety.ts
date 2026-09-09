/**
 * 书源规则来自远程 JSON，因此其中的 URL 不能直接信任。
 * 仅允许普通 HTTP(S) 地址，并拒绝认证信息和常见本机/内网地址。
 */
export function isSafeHttpUrl(value: string, allowTemplate = false): boolean {
  const candidate = allowTemplate ? value.replaceAll('{{key}}', 'novel') : value
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return false
  }

  if (!['http:', 'https:'].includes(url.protocol)) return false
  if (url.username || url.password || !url.hostname) return false

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'localhost.localdomain' || hostname === '::1' || hostname === '0.0.0.0' || hostname === '::') return false
  if (hostname.includes(':') && (hostname.startsWith('fc') || hostname.startsWith('fd') || /^fe[89ab]/.test(hostname))) return false

  const ipv4 = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (ipv4) {
    const [a = -1, b = -1, c = -1, d = -1] = ipv4.slice(1).map(Number)
    if ([a, b, c, d].some((part) => part < 0 || part > 255)) return false
    if (a === 10 || a === 127 || (a === 169 && b === 254) || (a === 192 && b === 168)) return false
    if (a === 172 && b >= 16 && b <= 31) return false
  }

  return true
}

export function assertSafeHttpUrl(value: string, label = '请求地址'): void {
  if (!isSafeHttpUrl(value)) throw new Error(`${label}不是安全的 HTTP(S) 地址`)
}
