// The readable-site half: converter, negotiation, build, middleware, MCP.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { aiTxt, buildMarkdown, sitemapRoutes } from '../src/build.mjs'
import { pageToMarkdown, stripTitleSuffix } from '../src/convert.mjs'
import { createMcpServer, discoveryDocs, normalizePath } from '../src/mcp.mjs'
import { createMarkdownMiddleware } from '../src/middleware.mjs'
import { markdownFile, prefersMarkdown } from '../src/negotiate.mjs'
import { createRateLimiter } from '../src/vercel-mcp.mjs'

const SITE = 'https://www.example.com'
const BIN = fileURLToPath(new URL('../bin/geo-kit.mjs', import.meta.url))

test('Accept negotiation: markdown only when preferred over HTML', () => {
  for (const accept of [undefined, '', '*/*', 'text/html', 'text/html,application/xhtml+xml,*/*;q=0.8',
    'text/html, text/markdown', 'text/markdown;q=0.5, text/html', 'text/markdown;q=0, */*', 'text/*']) {
    assert.equal(prefersMarkdown(accept), false, `HTML for ${accept}`)
  }
  for (const accept of ['text/markdown', 'text/markdown, text/html;q=0.9', 'text/html;q=0.5, text/markdown',
    'text/markdown, text/html, */*', 'TEXT/MARKDOWN; charset=utf-8', 'text/plain, text/markdown;q=0.9, */*;q=0.1']) {
    assert.equal(prefersMarkdown(accept), true, `markdown for ${accept}`)
  }
  assert.equal(markdownFile('/'), 'index.md')
  assert.equal(markdownFile('/docs/setup/'), 'docs/setup.md')
})

const PAGE = `<!doctype html><html><head><title>Pricing | Example</title>
<meta name="description" content="Public price &amp; terms." />
<link rel="canonical" href="https://www.example.com/pricing" /></head>
<body><header><nav><a href="/">Home</a></nav></header>
<main><h1>Two <br>plans</h1><p hidden>secret</p><div aria-hidden="true">decor</div>
<p>See <a href="/about">about</a> and <a href="#faq">the FAQ</a>.</p><p><span>$49</span><span>per month</span></p>
<table><thead><tr><th>Plan</th><th>Price</th></tr></thead><tbody><tr><td>Solo</td><td>$49 | mo</td></tr></tbody></table>
<details><summary><h3>Can I cancel?</h3></summary><p>Any time.</p></details>
<form><label>Email</label><input name="email"></form><img src="/a.png" alt=""><img src="/b.png" alt="A chart">
</main><footer>Footer links</footer></body></html>`

test('converter keeps only visible main content, with absolute links', () => {
  const { markdown, title } = pageToMarkdown(PAGE, { url: `${SITE}/pricing`, lastModified: '2026-10-25', siteName: 'Example' })
  assert.equal(title, 'Pricing')
  assert.match(markdown, /^# Pricing\n\n> Public price & terms\.\n\nCanonical: https:\/\/www\.example\.com\/pricing\nLast updated: 2026-10-25\n/)
  assert.match(markdown, /^## Two plans$/m)
  assert.match(markdown, /\[about\]\(https:\/\/www\.example\.com\/about\)/)
  assert.match(markdown, /\[the FAQ\]\(https:\/\/www\.example\.com\/pricing#faq\)/)
  assert.match(markdown, /\$49 per month/)
  assert.match(markdown, /\| Plan \| Price \|\n\| --- \| --- \|\n\| Solo \| \$49 \\\| mo \|/)
  assert.match(markdown, /^### Can I cancel\?$/m)
  assert.match(markdown, /!\[A chart\]\(https:\/\/www\.example\.com\/b\.png\)/)
  for (const absent of ['secret', 'decor', 'Footer links', 'Home', 'Email', 'a.png']) {
    assert.ok(!markdown.includes(absent), `markdown leaked "${absent}"`)
  }
  assert.equal(stripTitleSuffix('About - Example', 'Example'), 'About')
  assert.equal(stripTitleSuffix('Example', 'Example'), 'Example')
})

function fixture(t, { llms = true, org = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'geo-kit-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const dist = join(dir, 'dist')
  mkdirSync(join(dist, 'docs'), { recursive: true })
  const ld = { '@context': 'https://schema.org', '@graph': [{ '@type': 'Organization', name: 'Example', legalName: 'Example LLC', description: 'Invoicing for freelancers.', foundingDate: '2025', address: { addressLocality: 'Austin', addressRegion: 'TX' } }] }
  const words = Array(60).fill('word').join(' ')
  const page = (title, extra = '') => `<html><head><title>${title} | Example</title><meta name="description" content="${title} page." /></head><body><main><h1>${title}</h1><p>${words} invoice reminders</p>${extra}</main></body></html>`
  writeFileSync(join(dist, 'index.html'), page('Home', org ? `<script type="application/ld+json">${JSON.stringify(ld)}</script>` : '').replace('</head>', '</head>'))
  writeFileSync(join(dist, 'pricing.html'), page('Pricing'))
  writeFileSync(join(dist, 'docs', 'index.html'), page('Docs'))
  writeFileSync(join(dist, 'privacy.html'), page('Privacy'))
  writeFileSync(join(dist, 'thanks.html'), '<html><head><title>Thanks</title></head><body><main>Thanks.</main></body></html>')
  const url = (path, extra = '') => `<url><loc>${SITE}${path}</loc><lastmod>2026-10-20T00:00:00Z</lastmod>${extra}</url>`
  writeFileSync(join(dist, 'sitemap.xml'), `<?xml version="1.0"?><urlset>${url('/')}${url('/pricing', '<priority>0.9</priority>')}${url('/docs/')}${url('/privacy')}${url('/thanks')}</urlset>`)
  if (llms) writeFileSync(join(dist, 'llms.txt'), `# Example\n\n> Invoicing.\n\n- [Pricing](${SITE}/pricing): plans\n- [Blog](https://blog.example.com/)\n`)
  return { dir, dist }
}

const CONFIG = (dist) => ({ site: SITE, dist, skip: { '/thanks': 'Confirmation page.' }, core: ['/', '/pricing'], last: ['/privacy'], mcp: { endpoint: '/api/mcp' }, aiTxt: { contact: 'hi@example.com', excludes: ['/api/'] } })

test('build writes copies, llms files, ai.txt, catalog, head tags and MCP discovery', (t) => {
  const { dist } = fixture(t)
  const result = buildMarkdown(CONFIG(dist), { today: '2026-10-26' })
  assert.deepEqual(result, { pages: 4, fullChars: result.fullChars, llmsGenerated: false })

  for (const f of ['index.md', 'pricing.md', 'docs.md', 'privacy.md']) assert.ok(existsSync(join(dist, f)), f)
  assert.ok(!existsSync(join(dist, 'thanks.md')))
  assert.match(readFileSync(join(dist, 'pricing.md'), 'utf8'), /^# Pricing\n\n> Pricing page\.\n\nCanonical: https:\/\/www\.example\.com\/pricing\nLast updated: 2026-10-20\n/)

  const llms = readFileSync(join(dist, 'llms.txt'), 'utf8')
  assert.match(llms, /\[Pricing\]\(https:\/\/www\.example\.com\/pricing\.md\): plans/)
  assert.match(llms, /\[Blog\]\(https:\/\/blog\.example\.com\/\)/)
  assert.match(llms, /## Machine-readable[\s\S]*\[MCP server\]\(https:\/\/www\.example\.com\/api\/mcp\)/)

  const full = readFileSync(join(dist, 'llms-full.txt'), 'utf8')
  const order = ['/', '/pricing', '/docs', '/privacy'].map((p) => full.indexOf(`<!-- source: ${SITE}${p === '/' ? '/' : p} -->`))
  assert.ok(order.every((i, n) => i > -1 && (n === 0 || i > order[n - 1])), `llms-full order ${order}`)
  assert.match(full, /^# Example: full content\n\n> Invoicing for freelancers\./)

  const ai = readFileSync(join(dist, 'ai.txt'), 'utf8')
  for (const line of ['name: Example', 'legal_name: Example LLC', 'founded: 2025', 'location: Austin, TX', 'excludes: /api/', 'general: hi@example.com']) assert.ok(ai.includes(line), line)

  const catalog = JSON.parse(readFileSync(join(dist, 'md-catalog.json'), 'utf8'))
  assert.deepEqual(catalog.routes.map((r) => r.path), ['/', '/pricing', '/docs', '/privacy'])
  assert.equal(catalog.routes[1].markdown, `${SITE}/pricing.md`)
  assert.deepEqual(catalog.skipped, [{ path: '/thanks', reason: 'Confirmation page.' }])

  const html = readFileSync(join(dist, 'pricing.html'), 'utf8')
  assert.match(html, /<link rel="alternate" type="text\/markdown" href="https:\/\/www\.example\.com\/pricing\.md" \/>\n<meta name="ai-summary" content="Pricing page\." \/>\n<\/head>/)
  assert.equal(JSON.parse(readFileSync(join(dist, '.well-known', 'mcp.json'), 'utf8')).endpoint, `${SITE}/api/mcp`)

  assert.throws(() => buildMarkdown(CONFIG(dist)), /already has a Machine-readable section/)
})

test('build generates llms.txt when the site has none, and identity falls back to the head', (t) => {
  const { dist } = fixture(t, { llms: false, org: false })
  const result = buildMarkdown({ site: SITE, dist, skip: { '/thanks': 'x' } }, { today: '2026-10-26' })
  assert.equal(result.llmsGenerated, true)
  const llms = readFileSync(join(dist, 'llms.txt'), 'utf8')
  assert.match(llms, /^# Example\n\n> Home page\.\n\n## Pages\n\n- \[Home\]\(https:\/\/www\.example\.com\/index\.md\): Home page\./)
  assert.ok(!llms.includes('MCP server'))
})

test('build refuses pages it cannot honestly convert', (t) => {
  const { dist } = fixture(t)
  assert.throws(() => buildMarkdown({ site: SITE, dist }), /\/thanks converted to \d+ words/)
  assert.throws(() => sitemapRoutes(`<url><loc>https://other.com/x</loc></url>`, SITE), /off the site/)
  assert.throws(() => buildMarkdown({ site: 'example.com', dist }), /absolute URL/)
})

test('ai.txt can drop the default restrictions and opt out of training', () => {
  const txt = aiTxt({ base: SITE, identity: { name: 'X', legalName: 'X', description: '' }, generated: '2026-10-26', aiTxt: { replaceRestrictions: true, restrictions: ['Only this.'], training: false } })
  assert.match(txt, /\[restrictions\]\n- Only this\.\n\n/)
  assert.match(txt, /Training on this content is not permitted/)
})

test('middleware serves copies, negotiates, 404s in markdown and falls through otherwise', async (t) => {
  const files = { '/pricing.md': 'Canonical: https://www.example.com/pricing\nLast updated: 2026-10-20\n\nBody', '/md-catalog.json': '{"routes":[]}' }
  const seen = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const { pathname } = new URL(url)
    seen.push(init.headers)
    return files[pathname] != null
      ? new Response(files[pathname], { headers: { 'content-type': 'text/markdown' } })
      : new Response('<html>404</html>', { status: 404, headers: { 'content-type': 'text/html' } })
  }
  t.after(() => { globalThis.fetch = realFetch })
  const mw = createMarkdownMiddleware({ site: SITE })
  const req = (path, headers = {}, method = 'GET') => new Request(`${SITE}${path}`, { method, headers })

  const direct = await mw(req('/pricing.md', { cookie: 'session=1' }))
  assert.equal(direct.status, 200)
  assert.equal(direct.headers.get('content-type'), 'text/markdown; charset=utf-8')
  assert.equal(direct.headers.get('link'), '<https://www.example.com/pricing>; rel="canonical"')
  assert.equal(direct.headers.get('last-modified'), 'Tue, 20 Oct 2026 00:00:00 GMT')
  assert.equal(seen.at(-1).cookie, 'session=1')

  assert.equal((await mw(req('/pricing', { accept: 'text/markdown' }))).status, 200)
  assert.equal((await mw(req('/api/md/pricing'))).status, 200)
  assert.equal(await mw(req('/pricing', { accept: 'text/html,*/*' })), undefined)
  assert.equal(await mw(req('/secret', { accept: 'text/markdown' })), undefined, 'negotiated miss falls through to HTML')
  const miss = await mw(req('/nope.md'))
  assert.equal(miss.status, 404)
  assert.match(await miss.text(), /^# Not found/)
  assert.equal((await mw(req('/api/md/_catalog'))).headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal((await mw(req('/pricing.md', {}, 'POST'))).status, 405)
  assert.equal((await mw(req('/pricing.md', {}, 'HEAD'))).body, null)
  assert.equal(await mw(req('/pricing.md', { 'x-geo-kit-markdown-fetch': '1' })), undefined)

  globalThis.fetch = async () => { throw new Error('network down') }
  assert.equal(await mw(req('/pricing.md')), undefined, 'errors never cost the visitor the page')
})

test('MCP server lists, reads and searches only catalog pages', async () => {
  const { handleMessage, serverInfo } = createMcpServer({ site: SITE, name: 'Example' })
  assert.deepEqual(serverInfo, { name: 'example-site', title: 'Example site content', version: '1.0.0' })
  const routes = [
    { path: '/', title: 'Home', description: 'Invoicing for freelancers.', canonical: `${SITE}/`, markdown: `${SITE}/index.md` },
    { path: '/pricing', title: 'Pricing', description: 'Plans and prices.', canonical: `${SITE}/pricing`, markdown: `${SITE}/pricing.md` },
  ]
  const bodies = new Map([['/', 'Send invoices and reminders.'], ['/pricing', 'Solo plan costs $49 per month.']])
  const deps = { loadCatalog: async () => ({ routes }), loadPage: async (r) => bodies.get(r.path), loadAll: async () => bodies }
  const call = async (name, args) => (await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, deps)).result

  const init = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, deps)
  assert.equal(init.result.protocolVersion, '2025-03-26')
  assert.equal((await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, deps)).result.tools.length, 3)
  assert.match((await call('list_pages', {})).content[0].text, /^2 pages on example\.com/)
  assert.equal((await call('get_page', { path: 'https://example.com/pricing.md' })).content[0].text, 'Solo plan costs $49 per month.')
  assert.equal((await call('get_page', { path: '/missing' })).isError, true)
  assert.equal((await call('get_page', { path: 'https://evil.com/pricing' })).isError, true)
  assert.match((await call('search_pages', { query: 'price per month' })).content[0].text, /^1 matching page for "price per month":\n\n- Pricing \(\/pricing\)/)
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, deps), null)
  assert.equal((await handleMessage({ jsonrpc: '2.0', id: 3, method: 'nope' }, deps)).error.code, -32601)

  assert.equal(normalizePath('/docs/../secret', SITE), null)
  assert.equal(normalizePath('pricing/', SITE), '/pricing')
  assert.equal(discoveryDocs({ site: SITE, name: 'Example', endpoint: '/api/mcp' }).serverCard.tools.length, 3)
})

test('rate limiter allows the limit per window, then refuses', () => {
  const allow = createRateLimiter({ limit: 2, windowMs: 1000 })
  assert.deepEqual([allow('a', 0), allow('a', 1), allow('a', 2), allow('b', 2), allow('a', 1001)], [true, true, false, true, true])
})

test('CLI: init writes config and Vercel files, build runs end to end', (t) => {
  const { dir, dist } = fixture(t)
  const run = (...args) => execFileSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8' })
  run('init', 'vercel')
  for (const f of ['geo.config.mjs', 'geo-prompts.json', 'middleware.js', join('api', 'mcp.js')]) assert.ok(existsSync(join(dir, f)), f)
  assert.match(readFileSync(join(dir, 'middleware.js'), 'utf8'), /createMarkdownMiddleware\(\{ site: 'https:\/\/www\.example\.com' \}\)/)
  assert.match(run('init'), /kept .*geo\.config\.mjs/)
  writeFileSync(join(dir, 'geo.config.mjs'), `export default ${JSON.stringify({ site: SITE, skip: { '/thanks': 'x' } })}\n`)
  assert.match(run('build'), /^geo-kit: 4 markdown pages/)
  assert.ok(existsSync(join(dist, 'llms-full.txt')))
})
