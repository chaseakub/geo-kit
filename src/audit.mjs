// `geo-kit audit`: does an answer engine name you when a buyer asks?
//
// run    sends each prompt in prompts.json to Claude with web search, the way
//        a member of the public would ask it, and appends one row per answer
//        to results.jsonl. Already-answered prompt and run pairs are skipped,
//        so an interrupted run picks up where it stopped.
// add    records an answer you collected by hand from another engine
//        (ChatGPT, Google AI Mode, Perplexity) in the same results.jsonl.
// score  reads results.jsonl and reports, per engine: how often you were
//        mentioned, named first and cited, your share of voice against the
//        competitors you list, how stable that is across repeat runs, and
//        which sources the engines cited when they left you out. Those
//        sources are where to get listed next.
//
// Mentions are found by name and alias, citations by domain. Nothing here
// asks a model to grade itself, so every number in the report can be traced
// back to a line of results.jsonl.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_MODEL = 'claude-opus-5-5'
const SYSTEM = 'You are a helpful assistant chatting with a member of the public. Search the web when current information would help. Answer naturally. ' +
  'After your answer, add a final section headed SOURCES that lists every URL you relied on, one per line.'
const MAX_CONTINUES = 4

// ---------------------------------------------------------------- inputs

export function loadPrompts(file) {
  const prompts = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(prompts) || !prompts.length) throw new Error(`geo-kit: ${file} must be a non-empty JSON array of { id, text }.`)
  const seen = new Set()
  for (const p of prompts) {
    if (!p?.id || typeof p.text !== 'string' || !p.text.trim()) throw new Error(`geo-kit: every prompt needs an id and text (${JSON.stringify(p)}).`)
    if (seen.has(p.id)) throw new Error(`geo-kit: duplicate prompt id ${p.id}.`)
    seen.add(p.id)
  }
  return prompts
}

export function loadResults(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line, i) => {
    try {
      return JSON.parse(line)
    } catch {
      throw new Error(`geo-kit: ${file} line ${i + 1} is not JSON.`)
    }
  })
}

export function brandsFrom(audit) {
  if (!audit?.brand?.name) throw new Error('geo-kit: set audit.brand.name in geo.config.mjs.')
  const norm = (b, own) => ({ name: b.name, aliases: b.aliases ?? [], domains: b.domains ?? [], own })
  return [norm(audit.brand, true), ...(audit.competitors ?? []).map((c) => norm(typeof c === 'string' ? { name: c } : c, false))]
}

// ---------------------------------------------------------------- run

const URL_RE = /https?:\/\/[^\s<>()[\]"'`]+/g
const SOURCES_RE = /\n[#*\s]*SOURCES[*:\s]*\n([\s\S]*)$/i

// Answer text and the URLs behind it from one Messages API response.
// "cited" = URLs the answer relied on: its SOURCES list, links in the answer
// and any citation blocks. With dynamic filtering the model reads search
// results inside code execution, so text blocks usually carry no citations
// and the SOURCES list is the reliable record. "searched" = every result the
// web search returned. The SOURCES list is cut from the text so a domain in
// it is never scored as the answer naming that brand.
export function readAnswer(content) {
  const parts = []
  const cited = new Set()
  const searched = new Set()
  for (const block of content) {
    if (block.type === 'text') {
      parts.push(block.text)
      for (const c of block.citations ?? []) if (c.url) cited.add(c.url)
    } else if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content) if (r.type === 'web_search_result' && r.url) searched.add(r.url)
    }
  }
  let text = parts.join('').trim()
  const sources = text.match(SOURCES_RE)
  if (sources) text = text.slice(0, sources.index).trim()
  for (const u of [...(sources?.[1].match(URL_RE) ?? []), ...(text.match(URL_RE) ?? [])]) cited.add(u.replace(/[.,;:]+$/, ''))
  return { text, cited: [...cited], searched: [...searched] }
}

async function ask(client, { model, text, maxSearches }) {
  const messages = [{ role: 'user', content: text }]
  const content = []
  let response
  for (let turn = 0; turn <= MAX_CONTINUES; turn++) {
    response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: maxSearches }],
      messages,
    })
    content.push(...response.content)
    // A long search turn can pause; send it back as-is to let it finish.
    if (response.stop_reason !== 'pause_turn') break
    messages.push({ role: 'assistant', content: response.content })
  }
  return { content, stopReason: response.stop_reason, model: response.model, usage: response.usage }
}

export async function runAudit({ prompts, outDir, runs = 1, model = DEFAULT_MODEL, concurrency = 4, maxSearches = 5, client, log = () => {} }) {
  mkdirSync(join(outDir, 'raw'), { recursive: true })
  const resultsFile = join(outDir, 'results.jsonl')
  const done = new Set(loadResults(resultsFile).filter((r) => r.engine === 'claude').map((r) => `${r.id}#${r.run}`))
  const queue = []
  for (let run = 1; run <= runs; run++) for (const p of prompts) if (!done.has(`${p.id}#${run}`)) queue.push({ p, run })
  log(`geo-kit audit: ${queue.length} answers to fetch (${done.size} already in results.jsonl).`)

  const total = queue.length
  let failed = 0
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const { p, run } = job
      try {
        const res = await ask(client, { model, text: p.text, maxSearches })
        writeFileSync(join(outDir, 'raw', `claude_${p.id}_r${run}.json`), `${JSON.stringify(res, null, 2)}\n`)
        const answer = readAnswer(res.content)
        const row = { engine: 'claude', model: res.model, id: p.id, run, at: new Date().toISOString(), stop: res.stopReason, ...answer }
        appendFileSync(resultsFile, `${JSON.stringify(row)}\n`)
        log(`  ${p.id} run ${run}: ${answer.text.length} chars, ${answer.cited.length} cited, ${answer.searched.length} searched${res.stopReason === 'refusal' ? ' (refused)' : ''}`)
      } catch (error) {
        failed++
        log(`  ${p.id} run ${run}: FAILED ${error.status ?? ''} ${error.message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
  return { fetched: total - failed, failed }
}

export function addManualAnswer({ outDir, engine, id, run = 1, text, sources = [] }) {
  if (!engine || engine === 'claude') throw new Error('geo-kit: --engine names where the answer came from (chatgpt, aimode, perplexity, ...), not claude.')
  if (!text?.trim()) throw new Error('geo-kit: the answer text is empty.')
  mkdirSync(outDir, { recursive: true })
  const row = { engine, id, run, at: new Date().toISOString(), text: text.trim(), cited: sources, searched: [] }
  appendFileSync(join(outDir, 'results.jsonl'), `${JSON.stringify(row)}\n`)
  return row
}

// ---------------------------------------------------------------- score

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const hostOf = (url) => {
  try {
    return new URL(url).host.replace(/^www\./, '').toLowerCase()
  } catch {
    return null
  }
}

// Index of the first mention of a brand in the text, or -1.
export function firstMention(text, brand) {
  let best = -1
  for (const name of [brand.name, ...brand.aliases]) {
    const m = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'iu').exec(text)
    if (m && (best === -1 || m.index < best)) best = m.index
  }
  return best
}

export const citesDomain = (urls, brand) => urls.some((u) => {
  const host = hostOf(u)
  return host && brand.domains.some((d) => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`))
})

// Every brand the answer names, in the order it names them.
export function scoreAnswer(row, brands) {
  const urls = row.cited?.length ? row.cited : row.searched ?? []
  const mentions = brands
    .map((b) => ({ b, at: firstMention(row.text || '', b) }))
    .filter((m) => m.at !== -1)
    .sort((x, y) => x.at - y.at)
    .map((m) => m.b.name)
  const own = brands.find((b) => b.own)
  return {
    mentions,
    mentioned: mentions.includes(own.name),
    first: mentions[0] === own.name,
    position: mentions.indexOf(own.name) + 1 || null,
    cited: citesDomain(urls, own),
    urls,
  }
}

export function scoreAudit({ prompts, results, brands }) {
  const own = brands.find((b) => b.own)
  const byId = new Map(prompts.map((p) => [p.id, p]))
  // A prompt that names you already can't tell you whether engines find you.
  const brandPrompt = (p) => firstMention(p.text, own) !== -1
  const rows = results.filter((r) => byId.has(r.id)).map((r) => ({ ...r, prompt: byId.get(r.id), s: scoreAnswer(r, brands) }))
  const open = rows.filter((r) => !brandPrompt(r.prompt))
  const engines = [...new Set(rows.map((r) => r.engine))].sort()

  const perEngine = engines.map((engine) => {
    const rs = open.filter((r) => r.engine === engine)
    return {
      engine,
      answers: rs.length,
      mentioned: rs.filter((r) => r.s.mentioned).length,
      first: rs.filter((r) => r.s.first).length,
      cited: rs.filter((r) => r.s.cited).length,
    }
  })

  const share = brands.map((b) => ({ name: b.name, own: b.own, answers: open.filter((r) => r.s.mentions.includes(b.name)).length }))
    .sort((a, b) => b.answers - a.answers)

  const topics = [...new Set(open.map((r) => r.prompt.topic ?? 'untagged'))].sort().map((topic) => {
    const rs = open.filter((r) => (r.prompt.topic ?? 'untagged') === topic)
    return { topic, answers: rs.length, mentioned: rs.filter((r) => r.s.mentioned).length }
  })

  const stability = prompts.filter((p) => !brandPrompt(p)).map((p) => ({
    id: p.id,
    text: p.text,
    engines: engines.map((engine) => ({
      engine,
      runs: rows.filter((r) => r.id === p.id && r.engine === engine).sort((a, b) => a.run - b.run).map((r) => r.s.mentioned),
    })).filter((e) => e.runs.length),
  })).filter((p) => p.engines.some((e) => e.runs.length > 1))

  const gapDomains = new Map()
  const gapUrls = new Map()
  for (const r of open.filter((x) => !x.s.mentioned)) {
    for (const u of r.s.urls) {
      const h = hostOf(u)
      if (!h || own.domains.some((d) => h.endsWith(d))) continue
      gapDomains.set(h, (gapDomains.get(h) ?? 0) + 1)
      gapUrls.set(u, (gapUrls.get(u) ?? 0) + 1)
    }
  }
  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, count]) => ({ key, count }))

  const brandRows = rows.filter((r) => brandPrompt(r.prompt)).map((r) => ({ id: r.id, engine: r.engine, run: r.run, cited: r.s.cited, mentions: r.s.mentions }))

  return { brand: own.name, totals: { answers: rows.length, open: open.length, brandAnswers: brandRows.length }, perEngine, share, topics, stability, gapDomains: top(gapDomains, 20), gapUrls: top(gapUrls, 20), brandRows }
}

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : 'n/a')

export function reportMarkdown(score, { generated = new Date().toISOString().slice(0, 10) } = {}) {
  const b = score.brand
  const lines = [
    `# GEO audit: ${b}`,
    '',
    `Generated ${generated} by geo-kit from results.jsonl: ${score.totals.answers} answers, ${score.totals.open} to prompts that do not name ${b}. Prompts that name ${b} are reported separately at the end, because they cannot show whether engines find you on their own.`,
    '',
    '## Scoreboard',
    '',
    `| Engine | Answers | ${b} mentioned | Named first | ${b} site cited |`,
    '| --- | --- | --- | --- | --- |',
    ...score.perEngine.map((e) => `| ${e.engine} | ${e.answers} | ${e.mentioned} (${pct(e.mentioned, e.answers)}) | ${e.first} | ${e.cited} |`),
    '',
    '## Share of voice',
    '',
    'Answers that mention each brand, across every engine.',
    '',
    '| Brand | Answers |',
    '| --- | --- |',
    ...score.share.map((s) => `| ${s.own ? `**${s.name}**` : s.name} | ${s.answers} |`),
    '',
    '## By topic',
    '',
    `| Topic | Answers | ${b} mentioned |`,
    '| --- | --- | --- |',
    ...score.topics.map((t) => `| ${t.topic} | ${t.answers} | ${t.mentioned} |`),
  ]
  if (score.stability.length) {
    lines.push('', '## Repeat stability', '', `Y = ${b} mentioned in that run, . = not.`, '')
    for (const p of score.stability) lines.push(`- ${p.id} ${p.text.slice(0, 70)}: ${p.engines.map((e) => `${e.engine} ${e.runs.map((x) => (x ? 'Y' : '.')).join('')}`).join(', ')}`)
  }
  lines.push('', `## Where engines looked when they left ${b} out`, '', 'Get listed, reviewed or quoted on these. They are what the engines read for your buyers\' questions.', '',
    '| Domain | Citations |', '| --- | --- |', ...score.gapDomains.map((d) => `| ${d.key} | ${d.count} |`))
  if (score.gapUrls.length) lines.push('', 'Most-cited pages:', '', ...score.gapUrls.slice(0, 10).map((u) => `- ${u.count}x ${u.key}`))
  if (score.brandRows.length) {
    lines.push('', `## Prompts that name ${b}`, '', '| Prompt | Engine | Run | Site cited | Brands named, in order |', '| --- | --- | --- | --- | --- |',
      ...score.brandRows.map((r) => `| ${r.id} | ${r.engine} | ${r.run} | ${r.cited ? 'yes' : 'no'} | ${r.mentions.join(', ')} |`))
  }
  return `${lines.join('\n')}\n`
}
