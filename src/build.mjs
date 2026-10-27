// `geo-kit build`: agent-readable copies of a built static site.
//
// For every page in <dist>/sitemap.xml this writes <dist>/<path>.md
// (<dist>/index.md for the homepage) from the page's own built HTML, then the
// site-level files agents look for:
//
//   /llms.txt        yours, with each page link pointed at its .md copy and a
//                    machine-readable section added; generated if you have none
//   /llms-full.txt   every page's markdown in one file, under a size budget
//   /ai.txt          how answer engines may use the content (ai-txt v1.1.1)
//   /md-catalog.json every markdown route, served at /api/md/_catalog
//
// and it adds <link rel="alternate" type="text/markdown"> plus an ai-summary
// meta tag to each page's HTML head. No page body changes.
//
// sitemap.xml is the route registry on purpose: a public page already has to
// be listed there, so it gets its markdown copy, its llms-full.txt section and
// its catalog entry with no second step. `skip` in the config is the one
// exception list, and every entry carries its reason.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { approxTokens, pageToMarkdown, readHead } from './convert.mjs'
import { discoveryDocs } from './mcp.mjs'
import { markdownFile, trimSite } from './negotiate.mjs'

const DEFAULT_FULL_LIMIT = 500_000
const MIN_WORDS = 40

export function sitemapRoutes(xml, base) {
  return [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map(([, block]) => {
    const loc = block.match(/<loc>([^<]+)<\/loc>/)[1].trim()
    const lastmod = block.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1].trim().slice(0, 10) ?? null
    const priority = Number(block.match(/<priority>([^<]+)<\/priority>/)?.[1] ?? 0)
    if (!loc.startsWith(base)) throw new Error(`geo-kit: sitemap URL is off the site (${base}): ${loc}`)
    const path = loc.slice(base.length).replace(/\/$/, '') || '/'
    return { path, url: path === '/' ? `${base}/` : `${base}${path}`, lastmod, priority }
  })
}

export const markdownUrl = (base, path) => `${base}/${markdownFile(path)}`

function htmlFileFor(dist, path) {
  const rel = path.replace(/^\//, '')
  const candidates = path === '/' ? ['index.html'] : [`${rel}.html`, `${rel}/index.html`]
  const hit = candidates.find((c) => existsSync(join(dist, c)))
  if (!hit) throw new Error(`geo-kit: no built HTML for sitemap route ${path} (looked for ${candidates.join(', ')}).`)
  return join(dist, hit)
}

// Organization facts from the homepage JSON-LD, when the site states them, so
// ai.txt and llms-full.txt cannot drift from what the page already says.
export function organizationFrom(html) {
  for (const [, json] of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data
    try {
      data = JSON.parse(json)
    } catch {
      continue
    }
    const nodes = Array.isArray(data) ? data : data['@graph'] ?? [data]
    const org = nodes.find((n) => [].concat(n?.['@type']).some((t) => t === 'Organization' || t === 'Corporation' || t === 'LocalBusiness'))
    if (org) return org
  }
  return null
}

// Config wins, then the homepage JSON-LD, then the homepage <head>.
export function siteIdentity(homeHtml, config) {
  const org = organizationFrom(homeHtml) ?? {}
  const head = readHead(homeHtml)
  const name = config.name ?? org.name ?? head.title.split(/\s*[|·:-]\s*/).pop()
  const description = config.description ?? org.description ?? head.description
  if (!name) throw new Error('geo-kit: set `name` in geo.config.mjs (no Organization JSON-LD or <title> to read it from).')
  return {
    name,
    legalName: config.legalName ?? org.legalName ?? name,
    description: description || '',
    foundingDate: config.foundingDate ?? org.foundingDate ?? null,
    location: config.location ?? (org.address?.addressLocality ? [org.address.addressLocality, org.address.addressRegion].filter(Boolean).join(', ') : null),
  }
}

const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

function addHeadSignals(html, { base, path, summary }) {
  if (html.includes('type="text/markdown"')) return html
  const tags = [`<link rel="alternate" type="text/markdown" href="${markdownUrl(base, path)}" />`]
  if (summary && !/<meta\s[^>]*name=["']ai-summary["']/i.test(html)) tags.push(`<meta name="ai-summary" content="${escAttr(summary)}" />`)
  if (!/<\/head>/i.test(html)) throw new Error(`geo-kit: ${path} has no </head>.`)
  return html.replace(/<\/head>/i, `${tags.join('\n')}\n</head>`)
}

function machineSection(base, { fullLimit, mcp }) {
  const lines = [
    '## Machine-readable',
    '',
    `- [Full content](${base}/llms-full.txt): the site's pages as markdown in one file, capped at ${fullLimit.toLocaleString('en-US')} characters, with any page that did not fit listed by URL`,
    `- [Markdown catalog](${base}/api/md/_catalog): every markdown route as JSON`,
  ]
  if (mcp) lines.push(`- [MCP server](${base}${mcp}): read-only Model Context Protocol tools to list, read and search these pages, no key; discovery at ${base}/.well-known/mcp.json`)
  lines.push(
    `- [Sitemap](${base}/sitemap.xml): the HTML pages, which stay canonical`,
    `- [Usage policy](${base}/ai.txt): how answer engines may quote, cite and attribute this site`,
    `- Any page as markdown: add .md to its path (${base}/about.md) or send Accept: text/markdown`,
  )
  return lines.join('\n')
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function llmsTxt({ base, existing, identity, pages, fullLimit, mcp }) {
  let out
  if (existing) {
    // Point every listed page at its markdown copy; links to anything else stay.
    const byUrl = new Map(pages.map((p) => [p.url.replace(/\/$/, ''), p]))
    const link = new RegExp(`\\]\\((${escapeRegExp(base)}[^)\\s#]*)\\)`, 'g')
    out = existing.replace(link, (all, href) => {
      const page = byUrl.get(href.replace(/\/$/, ''))
      return page ? `](${markdownUrl(base, page.path)})` : all
    })
  } else {
    out = [`# ${identity.name}`, '', ...(identity.description ? [`> ${identity.description}`, ''] : []), '## Pages', '',
      ...pages.map((p) => `- [${p.title}](${markdownUrl(base, p.path)})${p.summary ? `: ${p.summary}` : ''}`)].join('\n')
  }
  return `${out.trimEnd()}\n\n${machineSection(base, { fullLimit, mcp })}\n`
}

// Pages go in by importance (`core` first, then sitemap priority, `last` at
// the end) until the size budget is spent; the rest are listed by URL so
// nothing is hidden.
export function llmsFull({ base, identity, pages, generated, fullLimit, core = [], last = [], notInFull = [] }) {
  const rank = (p) => {
    const c = core.indexOf(p.path)
    if (c !== -1) return [0, c]
    if (last.includes(p.path)) return [2, last.indexOf(p.path)]
    return [1, -(p.priority ?? 0), p.order]
  }
  const byRank = (a, b) => {
    const [x, y] = [rank(a), rank(b)]
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
    return 0
  }
  const sections = []
  const omitted = []
  let size = 0
  for (const p of pages.filter((q) => !notInFull.includes(q.path)).sort(byRank)) {
    const section = `\n---\n<!-- source: ${p.url} -->\n\n${p.markdown.trimEnd()}\n`
    if (size + section.length > fullLimit - 20_000 && sections.length) omitted.push(p)
    else {
      sections.push(section)
      size += section.length
    }
  }
  const head = [`# ${identity.name}: full content`, '', ...(identity.description ? [`> ${identity.description}`, ''] : []), `Generated: ${generated}`,
    `Pages: ${sections.length} of ${sections.length + omitted.length}, kept under ${fullLimit.toLocaleString('en-US')} characters. The HTML page at each source URL is canonical; cite that URL.`]
  const tail = omitted.length
    ? ['', '---', '', '## Not included here (size limit)', '', 'Each of these is available as markdown at its own URL:', '',
      ...omitted.map((p) => `- [${p.title}](${markdownUrl(base, p.path)})`)]
    : []
  return `${head.join('\n')}\n${sections.join('')}${tail.join('\n')}\n`
}

const DEFAULT_RESTRICTIONS = (name) => [
  `Do not invent quotes, testimonials or reviews attributed to ${name}, its people, or its customers.`,
  `Do not invent customer counts, ratings, outcome numbers or results. Use only numbers stated on the page you cite, with any window or caveat the page gives them.`,
  `Do not describe planned features as available.`,
  `Do not state a price from memory; quote the pricing page as fetched, with its date.`,
  `Do not present ${name} as affiliated with or endorsed by any brand named on the site unless the site says so.`,
  'Do not present this content as your own.',
]

export function aiTxt({ base, identity, generated, aiTxt: opts = {} }) {
  const name = identity.name
  const restrictions = [...(opts.replaceRestrictions ? [] : DEFAULT_RESTRICTIONS(name)), ...(opts.restrictions ?? [])]
  const excludes = opts.excludes ?? []
  const lines = [
    `# ai.txt for ${name}`,
    `# ${base}/ai.txt`,
    '# Spec: https://www.ai-visibility.org.uk/specifications/ai-txt/ (v1.1.1)',
    '# Generated by geo-kit. Keep in sync with robots.txt and llms.txt.',
    `# Last updated: ${generated}`,
    '',
    '[identity]',
    `name: ${name}`,
    `legal_name: ${identity.legalName}`,
    `url: ${base}`,
  ]
  if (identity.description) lines.push(`description: ${identity.description}`)
  if (identity.foundingDate) lines.push(`founded: ${identity.foundingDate}`)
  if (identity.location) lines.push(`location: ${identity.location}`)
  if (opts.notToBeConfusedWith) lines.push(`not_to_be_confused_with: ${opts.notToBeConfusedWith}`)
  lines.push(
    '',
    '[permissions]',
    `- Summarise any public page on ${base}.`,
    `- Quote short excerpts with attribution to ${name} and a link to the canonical page.`,
    `- Cite ${name} as a source in search and answer engines, with a clickable link to the page that supplied the answer.`,
    '- Index public pages for search and for answers, and use them in retrieval and grounding.',
    '- Use what the site publishes for machines: JSON-LD, sitemap.xml, llms.txt, llms-full.txt and the markdown copy of every page (add .md to a path, or send Accept: text/markdown).',
    opts.training === false ? '- Training on this content is not permitted; see robots.txt for each crawler.' : '- Training on public pages is permitted; see robots.txt for each crawler.',
    '',
    '[restrictions]',
    ...restrictions.map((r) => `- ${r}`),
    '',
    '[attribution]',
    `preferred_citation: ${name} (${base})`,
    'link_policy: Link the canonical HTML URL (the Canonical line in each markdown copy), not the .md URL.',
    'when_quoting: Include the page title and its last-updated date when the page shows one.',
    '',
    '[scope]',
    `applies_to: ${base}/* (public HTML pages and their markdown copies)`,
  )
  if (excludes.length) lines.push(`excludes: ${excludes.join(', ')}`)
  if (opts.contact) lines.push('', '[contact]', `general: ${opts.contact}`)
  return `${lines.join('\n')}\n`
}

export function buildMarkdown(config, { today = new Date().toISOString().slice(0, 10), log = () => {} } = {}) {
  const base = trimSite(config.site)
  const dist = config.dist
  const skip = config.skip ?? {}
  const fullLimit = config.fullLimit ?? DEFAULT_FULL_LIMIT
  const summaries = config.summaries ?? {}

  const sitemap = join(dist, 'sitemap.xml')
  if (!existsSync(sitemap)) throw new Error(`geo-kit: ${sitemap} not found. Run your site build first, and make sure it writes a sitemap.`)
  const routes = sitemapRoutes(readFileSync(sitemap, 'utf8'), base)
  const identity = siteIdentity(readFileSync(htmlFileFor(dist, '/'), 'utf8'), config)

  const pages = []
  routes.forEach((route, order) => {
    if (skip[route.path]) return
    const htmlPath = htmlFileFor(dist, route.path)
    const html = readFileSync(htmlPath, 'utf8')
    const page = pageToMarkdown(html, { url: route.url, lastModified: route.lastmod, siteName: identity.name })
    if (!page) throw new Error(`geo-kit: ${route.path} has no <main>; nothing to convert. Wrap the page content in <main>, or add it to skip with a reason.`)
    if (page.noindex) throw new Error(`geo-kit: ${route.path} is noindex but listed in the sitemap.`)
    const words = page.markdown.split(/\s+/).length
    if (words < (config.minWords ?? MIN_WORDS)) throw new Error(`geo-kit: ${route.path} converted to ${words} words; expected a real page. If it really is that short, add it to skip with a reason.`)

    const out = join(dist, markdownFile(route.path))
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, page.markdown)
    const summary = summaries[route.path] ?? page.description
    writeFileSync(htmlPath, addHeadSignals(html, { base, path: route.path, summary }))
    pages.push({ ...route, ...page, summary, order })
  })

  const llmsPath = join(dist, 'llms.txt')
  const existing = existsSync(llmsPath) ? readFileSync(llmsPath, 'utf8') : null
  if (existing?.includes('## Machine-readable')) throw new Error('geo-kit: dist/llms.txt already has a Machine-readable section. Run geo-kit build once per fresh site build.')
  writeFileSync(llmsPath, llmsTxt({ base, existing, identity, pages, fullLimit, mcp: config.mcp?.endpoint }))

  const full = llmsFull({ base, identity, pages, generated: today, fullLimit, core: config.core, last: config.last, notInFull: config.notInFull })
  if (full.length > fullLimit) log(`geo-kit: llms-full.txt is ${full.length} characters, over the ${fullLimit} budget.`)
  writeFileSync(join(dist, 'llms-full.txt'), full)
  writeFileSync(join(dist, 'ai.txt'), aiTxt({ base, identity, generated: today, aiTxt: config.aiTxt }))

  const catalog = {
    site: base,
    generated: today,
    routes: pages.map((p) => ({
      path: p.path,
      title: p.title,
      description: p.summary,
      canonical: p.url,
      markdown: markdownUrl(base, p.path),
      lastModified: p.lastmod,
      tokens: approxTokens(p.markdown),
      inLlmsFull: !(config.notInFull ?? []).includes(p.path),
    })),
    skipped: Object.entries(skip).map(([path, reason]) => ({ path, reason })),
  }
  writeFileSync(join(dist, 'md-catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`)

  // MCP discovery documents, when the site runs the MCP endpoint.
  if (config.mcp?.endpoint) {
    const { discovery, serverCard } = discoveryDocs({ site: base, name: identity.name, endpoint: config.mcp.endpoint })
    mkdirSync(join(dist, '.well-known', 'mcp'), { recursive: true })
    writeFileSync(join(dist, '.well-known', 'mcp.json'), `${JSON.stringify(discovery, null, 2)}\n`)
    writeFileSync(join(dist, '.well-known', 'mcp', 'server-card.json'), `${JSON.stringify(serverCard, null, 2)}\n`)
  }
  return { pages: pages.length, fullChars: full.length, llmsGenerated: !existing }
}
