// Accept-header negotiation and path mapping, shared by the build and every
// server adapter.

// q-value of the most specific Accept range that matches `type`.
function qualityFor(ranges, type) {
  const [main] = type.split('/')
  let best = { specificity: -1, q: 0 }
  for (const { range, q } of ranges) {
    const specificity = range === type ? 2 : range === `${main}/*` ? 1 : range === '*/*' ? 0 : -1
    if (specificity > best.specificity) best = { specificity, q }
  }
  return best.q
}

// Markdown only when the client prefers it over HTML. A missing Accept header
// or */* always means HTML. On a tie, the type the client listed first wins:
// browsers never list text/markdown, so a tie only ever comes from an agent
// that put markdown first.
export function prefersMarkdown(accept) {
  if (!accept) return false
  const ranges = accept.split(',').map((part, index) => {
    const [range, ...params] = part.trim().toLowerCase().split(';').map((s) => s.trim())
    const qParam = params.find((p) => p.startsWith('q='))
    const q = qParam ? Number(qParam.slice(2)) : 1
    return { range, q: Number.isFinite(q) ? q : 0, index }
  })
  const md = qualityFor(ranges, 'text/markdown')
  const html = qualityFor(ranges, 'text/html')
  if (md <= 0 || ranges.every((r) => r.range !== 'text/markdown')) return false
  if (md !== html) return md > html
  const firstHtml = ranges.find((r) => r.range === 'text/html' || r.range === 'text/*' || r.range === '*/*')
  return !firstHtml || ranges.find((r) => r.range === 'text/markdown').index < firstHtml.index
}

// /pricing -> pricing.md, / -> index.md. The .md sits beside the page's own
// HTML so /pricing.md can be served as a plain static file.
export const markdownFile = (path) => (path === '/' || path === '' ? 'index.md' : `${path.replace(/^\//, '').replace(/\/$/, '')}.md`)
export const markdownPathFor = (pathname) => `/${markdownFile(pathname)}`

export const trimSite = (site) => {
  if (!/^https?:\/\/[^/]+/i.test(site || '')) throw new Error(`geo-kit: site must be an absolute URL such as https://www.example.com (got ${site}).`)
  return site.replace(/\/+$/, '')
}
