// Vercel (Node runtime) transport for the MCP server: Streamable HTTP,
// stateless, JSON responses only.
//
// Agents POST JSON-RPC here; createMcpServer answers it from the markdown
// copies the build wrote, read back from this same deployment, so a preview
// serves its own content. No sessions and no server-to-client stream: GET
// answers 405, which the spec allows for a server that never pushes.
// Everything returned is already public on the site, so there is no auth; a
// per-IP limit keeps search, which reads every page, from being used as a
// fetch amplifier.
import { createMcpServer, httpLoaders } from './mcp.mjs'
import { trimSite } from './negotiate.mjs'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id',
}
const FORWARD = ['cookie', 'x-vercel-protection-bypass', 'x-vercel-trusted-oidc-idp-token']

// Fixed-window limit per IP, in memory. Per instance, so it is a brake, not
// a guarantee; put a firewall rule in front if you need a hard limit.
export function createRateLimiter({ limit, windowMs }) {
  const hits = new Map()
  return function allow(key, now = Date.now()) {
    const entry = hits.get(key)
    if (!entry || now - entry.start > windowMs) {
      if (hits.size > 10_000) hits.clear()
      hits.set(key, { start: now, count: 1 })
      return true
    }
    entry.count++
    return entry.count <= limit
  }
}

// The deployment that is answering, from Vercel's own environment, never
// from a request header: production reads the public site, a preview reads
// its own deployment URL.
function originFor(site) {
  const { VERCEL_ENV, VERCEL_URL } = process.env
  return VERCEL_ENV && VERCEL_ENV !== 'production' && VERCEL_URL ? `https://${VERCEL_URL}` : site
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null && req.body !== '') {
    return typeof req.body === 'string' ? JSON.parse(req.body) : req.body
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
}

export function createVercelMcpHandler({ site, name, instructions, rateLimit = { limit: 120, windowMs: 60_000 } } = {}) {
  const base = trimSite(site)
  const { handleMessage } = createMcpServer({ site: base, name, instructions })
  const allow = createRateLimiter(rateLimit)
  const store = {}

  return async function handler(req, res) {
    for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v)
    res.setHeader('X-Robots-Tag', 'noindex')

    if (req.method === 'OPTIONS') return res.status(204).end()
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS')
      return res.status(405).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: `POST JSON-RPC to this endpoint. Discovery: ${base}/.well-known/mcp.json` } })
    }
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown'
    if (!allow(ip)) {
      return res.status(429).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Too many requests. Try again in a minute.' } })
    }

    let message
    try {
      message = await readBody(req)
    } catch {
      return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    }

    const headers = {}
    for (const h of FORWARD) if (req.headers[h]) headers[h] = req.headers[h]
    const deps = httpLoaders({ origin: originFor(base), headers, store })

    if (Array.isArray(message)) {
      if (!message.length) return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } })
      const replies = (await Promise.all(message.slice(0, 20).map((m) => handleMessage(m, deps)))).filter(Boolean)
      return replies.length ? res.status(200).json(replies) : res.status(202).end()
    }
    const reply = await handleMessage(message, deps)
    return reply ? res.status(200).json(reply) : res.status(202).end()
  }
}
