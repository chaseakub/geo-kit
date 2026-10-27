// Edge middleware (Web-standard Request/Response) that serves the markdown
// copies `geo-kit build` wrote. Works with Vercel Routing Middleware and any
// runtime that hands you a Request and lets you return a Response or
// undefined to fall through.
//
//   GET /pricing.md                          the copy, always
//   GET /api/md/pricing                      the copy, always (debugging)
//   GET /pricing  Accept: text/markdown      the copy, when markdown is preferred
//   GET /api/md/_catalog                     every markdown route as JSON
//
// Everything else, including every browser, curl with */* and link previews,
// falls through untouched to the HTML. The set of pages that can answer in
// markdown is exactly the set of .md files the build wrote, so there is no
// second route list to keep in sync. A markdown URL with no copy behind it
// gets a markdown 404, never the HTML 404 page.
import { markdownPathFor, prefersMarkdown, trimSite } from './negotiate.mjs'

const INTERNAL = 'x-geo-kit-markdown-fetch'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept',
}
const CACHE = 'public, s-maxage=3600, stale-while-revalidate=86400'

// Headers that let the visitor through deployment protection (Vercel preview
// auth and its bypass tokens) are carried onto the internal read.
const FORWARD = ['cookie', 'x-vercel-protection-bypass', 'x-vercel-trusted-oidc-idp-token']

export function createMarkdownMiddleware({ site, catalogPath = '/md-catalog.json', apiPrefix = '/api/md' } = {}) {
  const base = trimSite(site)

  const notFound = (requested) => ({
    status: 404,
    body: `# Not found\n\n> There is no markdown copy of this page.\n\nRequested: ${requested}\n\nEvery page with a markdown copy is listed at ${base}${apiPrefix}/_catalog and ${base}/llms.txt.\n`,
  })

  function respond(method, { body, status, headers }) {
    const all = {
      ...CORS,
      'Content-Type': 'text/markdown; charset=utf-8',
      'X-Markdown-Tokens': String(Math.ceil(body.length / 4)),
      'X-Robots-Tag': 'noindex, follow',
      ...headers,
    }
    return new Response(method === 'HEAD' ? null : body, { status, headers: all })
  }

  // The copy is read with a same-deployment fetch marked INTERNAL; that
  // request skips this middleware and is served as the plain static file.
  async function readStatic(request, path) {
    const headers = { [INTERNAL]: '1' }
    for (const name of FORWARD) {
      const value = request.headers.get(name)
      if (value) headers[name] = value
    }
    const res = await fetch(new URL(path, request.url), { headers })
    const type = res.headers.get('content-type') || ''
    if (!res.ok || type.includes('text/html')) return null
    return res.text()
  }

  async function handle(request) {
    if (request.headers.get(INTERNAL)) return undefined
    const url = new URL(request.url)
    const { pathname } = url
    const method = request.method.toUpperCase()

    let mdPath = null
    let negotiated = false
    if (pathname === `${apiPrefix}/_catalog`) {
      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
      const catalog = await readStatic(request, catalogPath)
      if (!catalog) return respond(method, notFound(url.href))
      return new Response(method === 'HEAD' ? null : catalog, {
        headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': CACHE, 'X-Robots-Tag': 'noindex' },
      })
    } else if (pathname === apiPrefix || pathname.startsWith(`${apiPrefix}/`)) {
      mdPath = markdownPathFor(pathname.slice(apiPrefix.length))
    } else if (pathname.endsWith('.md')) {
      mdPath = pathname
    } else if (!pathname.slice(pathname.lastIndexOf('/')).includes('.') && prefersMarkdown(request.headers.get('accept'))) {
      mdPath = markdownPathFor(pathname)
      negotiated = true
    }
    if (!mdPath) return undefined

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
    if (method !== 'GET' && method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { ...CORS, Allow: 'GET, HEAD, OPTIONS' } })
    }

    const body = await readStatic(request, mdPath)
    // A negotiated request for a page with no copy (a private or excluded
    // page) gets that page exactly as a browser would.
    if (body == null) return negotiated ? undefined : respond(method, notFound(url.href))

    const canonical = body.match(/^Canonical: (\S+)$/m)?.[1]
    const updated = body.match(/^Last updated: (\d{4}-\d{2}-\d{2})$/m)?.[1]
    const headers = { 'Cache-Control': CACHE, Vary: 'Accept' }
    if (canonical) {
      headers['Content-Location'] = canonical
      headers.Link = `<${canonical}>; rel="canonical"`
    }
    if (updated) headers['Last-Modified'] = new Date(`${updated}T00:00:00Z`).toUTCString()
    return respond(method, { body, status: 200, headers })
  }

  // This runs in front of every page, so a failure here must never cost a
  // visitor the HTML: any error falls through to the normal response.
  return async function markdownMiddleware(request) {
    try {
      return await handle(request)
    } catch (error) {
      console.error('[geo-kit middleware]', error)
      return undefined
    }
  }
}
