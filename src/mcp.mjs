// Read-only Model Context Protocol server over a site's markdown copies.
//
// `geo-kit build` writes a markdown copy of every public page and
// md-catalog.json listing them. This module answers MCP JSON-RPC messages
// with three tools over exactly that set: list_pages, get_page and
// search_pages. It holds no state, needs no key and can only return what the
// public site already serves, so the catalog is the whole permission model.
//
// The transport passes in loadCatalog(), loadPage(route) and loadAll(routes),
// so this file stays pure and testable without a network.
import { trimSite } from './negotiate.mjs'

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const MAX_QUERY = 200
const MAX_RESULTS = 20

const hostOf = (site) => new URL(site).host.replace(/^www\./, '')
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export function toolsFor(site) {
  const host = hostOf(site)
  return [
    {
      name: 'list_pages',
      title: 'List pages',
      description: `Every public ${host} page that has a markdown copy: path, title, one-line description, canonical URL and last-updated date.`,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'get_page',
      title: 'Read a page',
      description: `One ${host} page as markdown, by path (for example "/pricing"). Use list_pages or search_pages to find paths.`,
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: `Site path such as "/pricing". A full ${host} URL also works.` } },
        required: ['path'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'search_pages',
      title: 'Search pages',
      description: `Keyword search across every ${host} page (titles, descriptions and full text). Returns the best matches with a snippet each.`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Words to look for.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_RESULTS, description: `How many results, 1 to ${MAX_RESULTS}. Default 5.` },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
  ]
}

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result })
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
const text = (body) => ({ content: [{ type: 'text', text: body }] })
const toolError = (message) => ({ content: [{ type: 'text', text: message }], isError: true })

// "/pricing", "pricing", "/pricing/", "/pricing.md" and the full URL all mean
// the same page. Anything that is not a plain path on this site returns null.
export function normalizePath(input, site) {
  if (typeof input !== 'string') return null
  let path = input.trim()
  const host = hostOf(site).replace(/[.]/g, '\\.')
  const url = path.match(new RegExp(`^https?://(?:www\\.)?${host}(/[^?#]*)?`, 'i'))
  if (url) path = url[1] || '/'
  else if (/^[a-z]+:/i.test(path)) return null
  path = path.split(/[?#]/)[0]
  if (!path.startsWith('/')) path = `/${path}`
  path = path.replace(/\.md$/, '').replace(/\/index$/, '/').replace(/(.)\/+$/, '$1')
  return /^\/[a-z0-9/_.-]*$/i.test(path) && !path.includes('..') ? path || '/' : null
}

function pageLine(route) {
  const parts = [`- ${route.title} (${route.path})`]
  if (route.description) parts.push(`  ${route.description}`)
  parts.push(`  ${route.canonical}${route.lastModified ? ` · updated ${route.lastModified}` : ''}`)
  return parts.join('\n')
}

// Lowercased query words with a light stem, so "price" also finds "pricing"
// and "reviews" finds "review".
const terms = (query) => [...new Set(query.toLowerCase().split(/[^a-z0-9$]+/)
  .filter((t) => t.length > 1)
  .map((t) => (t.length > 4 ? t.replace(/(ing|ed|es|s|e)$/, '') : t)))]

function count(haystack, term) {
  let n = 0
  for (let i = haystack.indexOf(term); i !== -1 && n < 50; i = haystack.indexOf(term, i + term.length)) n++
  return n
}

function snippet(body, words) {
  const lower = body.toLowerCase()
  const at = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0
  const start = Math.max(0, at - 120)
  const clip = body.slice(start, start + 300).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${clip}${start + 300 < body.length ? '…' : ''}`
}

// A small BM25: a word found on few pages counts more than one found on all
// of them, repeats saturate so long pages do not win on length, and a hit in
// the title or description outweighs any number of body hits.
export function rankPages(routes, bodies, query, limit) {
  const words = terms(query)
  if (!words.length) return []
  const docs = routes.map((route) => ({
    route,
    title: (route.title || '').toLowerCase(),
    description: (route.description || '').toLowerCase(),
    body: (bodies.get(route.path) || '').toLowerCase(),
  }))
  const avgLen = docs.reduce((n, d) => n + d.body.length, 0) / (docs.length || 1) || 1
  const idf = new Map(words.map((w) => {
    const df = docs.filter((d) => d.title.includes(w) || d.description.includes(w) || d.body.includes(w)).length
    return [w, Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))]
  }))
  return docs
    .map((d) => {
      let score = 0
      let matched = 0
      for (const w of words) {
        const tf = count(d.body, w)
        const field = (d.title.includes(w) ? 3 : 0) + (d.description.includes(w) ? 1.5 : 0)
        if (!tf && !field) continue
        matched++
        const bodyScore = (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (d.body.length / avgLen)))
        score += idf.get(w) * (bodyScore + field)
      }
      return { route: d.route, score: score * Math.sqrt(matched / words.length), matched }
    })
    .filter((r) => r.matched > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => ({ ...r, snippet: snippet(bodies.get(r.route.path) || r.route.description || '', words) }))
}

export function createMcpServer({ site, name, version = '1.0.0', instructions } = {}) {
  const base = trimSite(site)
  const host = hostOf(base)
  const tools = toolsFor(base)
  const serverInfo = { name: `${slug(name || host)}-site`, title: `${name || host} site content`, version }
  const info = instructions ?? `Public, read-only content from ${host} as markdown. Cite the canonical HTML URL each tool returns, not the .md URL.`

  async function callTool(tool, args, { loadCatalog, loadPage, loadAll }) {
    if (tool === 'list_pages') {
      const { routes } = await loadCatalog()
      return text(`${routes.length} pages on ${host}. Read one with get_page.\n\n${routes.map(pageLine).join('\n')}`)
    }

    if (tool === 'get_page') {
      const path = normalizePath(args?.path, base)
      if (!path) return toolError(`path must be a ${host} path such as "/pricing".`)
      const { routes } = await loadCatalog()
      const route = routes.find((r) => r.path === path)
      if (!route) return toolError(`No page at ${path}. Use list_pages or search_pages to find one.`)
      const body = await loadPage(route)
      if (body == null) return toolError(`${path} could not be read right now. Try again, or fetch ${route.markdown}.`)
      return text(body)
    }

    if (tool === 'search_pages') {
      const query = typeof args?.query === 'string' ? args.query.slice(0, MAX_QUERY) : ''
      if (!terms(query).length) return toolError('query needs at least one word.')
      const limit = Math.min(MAX_RESULTS, Math.max(1, Number.isInteger(args?.limit) ? args.limit : 5))
      const { routes } = await loadCatalog()
      const bodies = await loadAll(routes)
      const hits = rankPages(routes, bodies, query, limit)
      if (!hits.length) return text(`No pages match "${query}". list_pages shows everything there is.`)
      const lines = hits.map(({ route, snippet: s }) => `- ${route.title} (${route.path})\n  ${route.canonical}\n  ${s}`)
      return text(`${hits.length} matching page${hits.length === 1 ? '' : 's'} for "${query}":\n\n${lines.join('\n\n')}`)
    }

    return null
  }

  // One JSON-RPC message in, one response out (or null for a notification).
  async function handleMessage(message, deps) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return rpcError(message?.id, -32600, 'Invalid Request')
    }
    const { id, method, params } = message
    if (id === undefined) return null // notifications/initialized and friends need no reply

    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo,
          instructions: info,
        })
      }
      case 'ping':
        return rpcResult(id, {})
      case 'tools/list':
        return rpcResult(id, { tools })
      case 'tools/call': {
        try {
          const result = await callTool(params?.name, params?.arguments ?? {}, deps)
          return result ? rpcResult(id, result) : rpcError(id, -32602, `Unknown tool: ${params?.name}`)
        } catch (error) {
          console.error('[geo-kit mcp] tool failed', params?.name, error)
          return rpcResult(id, toolError('The site content could not be loaded right now. Try again shortly.'))
        }
      }
      case 'resources/list':
        return rpcResult(id, { resources: [] })
      case 'prompts/list':
        return rpcResult(id, { prompts: [] })
      default:
        return rpcError(id, -32601, `Method not found: ${method}`)
    }
  }

  return { handleMessage, serverInfo, tools }
}

// /.well-known/mcp.json and the server card beside it.
export function discoveryDocs({ site, name, endpoint }) {
  const base = trimSite(site)
  const { serverInfo, tools } = createMcpServer({ site: base, name })
  const url = `${base}${endpoint}`
  const description = `Public, read-only Model Context Protocol tools for ${hostOf(base)}: list, read and search every public page as markdown. No API key.`
  return {
    discovery: {
      name: serverInfo.title,
      description,
      endpoint: url,
      transport: 'streamable-http',
      mcp_version: PROTOCOL_VERSIONS[0],
      endpoints: [{ url, transport: 'streamable-http', capabilities: ['tools'], auth: { type: 'none' } }],
      documentation: `${base}/llms.txt`,
      serverCard: `${base}/.well-known/mcp/server-card.json`,
    },
    serverCard: {
      version: '1.0',
      protocolVersion: PROTOCOL_VERSIONS[0],
      serverInfo,
      description,
      transport: { type: 'streamable-http', endpoint: url },
      authentication: { required: false },
      capabilities: { tools: { listChanged: false } },
      tools,
    },
  }
}

// Loaders that read the catalog and pages back from the deployment over
// HTTP, with a short in-memory cache. `origin` is where the files are served
// (your production site, or a preview's own URL).
export function httpLoaders({ origin, headers = {}, cacheMs = 10 * 60 * 1000, store }) {
  const now = Date.now()
  if (!store.at || store.origin !== origin || now - store.at > cacheMs) Object.assign(store, { origin, at: now, catalog: null, pages: new Map() })

  async function loadCatalog() {
    if (store.catalog) return store.catalog
    const res = await fetch(`${origin}/md-catalog.json`, { headers })
    if (!res.ok) throw new Error(`md-catalog.json returned ${res.status}`)
    store.catalog = await res.json()
    return store.catalog
  }

  async function loadPage(route) {
    if (store.pages.has(route.path)) return store.pages.get(route.path)
    const res = await fetch(`${origin}${new URL(route.markdown).pathname}`, { headers })
    const type = res.headers.get('content-type') || ''
    const body = res.ok && !type.includes('text/html') ? await res.text() : null
    if (body != null) store.pages.set(route.path, body)
    return body
  }

  async function loadAll(routes) {
    const queue = [...routes]
    const workers = Array.from({ length: 8 }, async () => {
      for (let route = queue.shift(); route; route = queue.shift()) await loadPage(route).catch(() => null)
    })
    await Promise.all(workers)
    return store.pages
  }

  return { loadCatalog, loadPage, loadAll }
}
