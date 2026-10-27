// The measuring half: answer parsing, run (against a fake client), scoring.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { addManualAnswer, brandsFrom, firstMention, loadPrompts, loadResults, readAnswer, reportMarkdown, runAudit, scoreAnswer, scoreAudit } from '../src/audit.mjs'

const AUDIT = {
  brand: { name: 'Example', aliases: ['Example App'], domains: ['example.com'] },
  competitors: [{ name: 'Rival', domains: ['rival.com'] }, 'Other'],
}
const brands = brandsFrom(AUDIT)
const PROMPTS = [
  { id: 'P01', topic: 'category', text: 'Best invoicing software?' },
  { id: 'P02', topic: 'pricing', text: 'Invoicing software cost?' },
  { id: 'P03', topic: 'brand', text: 'Is Example any good?' },
]

const tmp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'geo-kit-audit-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('readAnswer joins text and separates cited from searched URLs', () => {
  const answer = readAnswer([
    { type: 'server_tool_use', name: 'web_search', input: { query: 'x' } },
    { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://list.com/best' }, { type: 'web_search_result', url: 'https://rival.com/' }] },
    { type: 'text', text: 'Try Rival', citations: [{ type: 'web_search_result_location', url: 'https://list.com/best' }] },
    { type: 'text', text: ' or Example.' },
    { type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
  ])
  assert.deepEqual(answer, { text: 'Try Rival or Example.', cited: ['https://list.com/best'], searched: ['https://list.com/best', 'https://rival.com/'] })
})

test('mentions are whole-word, alias-aware and ordered', () => {
  assert.equal(firstMention('Examples abound', brands[0]), -1)
  assert.equal(firstMention('I like example app.', brands[0]), 7)
  const s = scoreAnswer({ text: 'Rival first, then Example, then Other.', cited: ['https://www.example.com/pricing'] }, brands)
  assert.deepEqual([s.mentions, s.mentioned, s.first, s.position, s.cited], [['Rival', 'Example', 'Other'], true, false, 2, true])
  assert.equal(scoreAnswer({ text: 'Nothing', cited: [], searched: ['https://notexample.com'] }, brands).cited, false)
})

test('runAudit asks each prompt with web search, records rows, and resumes', async (t) => {
  const out = tmp(t)
  const calls = []
  const client = {
    beta: {
      messages: {
        create: async (body) => {
          calls.push(body)
          const q = body.messages[0].content
          // P02 pauses once mid-search, then finishes.
          if (q.includes('cost') && body.messages.length === 1) return { model: body.model, stop_reason: 'pause_turn', content: [{ type: 'text', text: 'Looking. ' }] }
          if (q.includes('good')) throw Object.assign(new Error('overloaded'), { status: 529 })
          return { model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: `Answer to ${q} Rival.`, citations: [{ url: 'https://list.com/x' }] }] }
        },
      },
    },
  }
  const first = await runAudit({ prompts: PROMPTS, outDir: out, runs: 2, model: 'claude-opus-5-5', concurrency: 2, client })
  assert.deepEqual(first, { fetched: 4, failed: 2 })
  const body = calls[0]
  assert.equal(body.tools[0].type, 'web_search_20260209')
  assert.equal(body.fallbacks, 'default')
  assert.deepEqual(body.betas, ['server-side-fallback-2026-07-01'])
  const rows = loadResults(join(out, 'results.jsonl'))
  assert.equal(rows.length, 4)
  const p2 = rows.find((r) => r.id === 'P02')
  assert.equal(p2.text, 'Looking. Answer to Invoicing software cost? Rival.')
  assert.deepEqual(p2.cited, ['https://list.com/x'])

  calls.length = 0
  const second = await runAudit({ prompts: PROMPTS, outDir: out, runs: 2, client })
  assert.deepEqual(second, { fetched: 0, failed: 2 }, 'only the failed P03 runs are retried')
  assert.ok(calls.every((c) => c.messages[0].content.includes('good')))
})

test('score separates brand prompts, counts per engine, and lists gap sources', (t) => {
  const out = tmp(t)
  const row = (engine, id, run, text, cited) => ({ engine, id, run, text, cited, searched: [] })
  const results = [
    row('claude', 'P01', 1, 'Rival and Other are popular.', ['https://list.com/best', 'https://rival.com/']),
    row('claude', 'P01', 2, 'Example is great, so is Rival.', ['https://example.com/']),
    row('claude', 'P02', 1, 'Rival costs $10.', ['https://list.com/best']),
    row('claude', 'P03', 1, 'Example is fine.', ['https://example.com/']),
  ]
  addManualAnswer({ outDir: out, engine: 'chatgpt', id: 'P01', text: 'Other, then Example.', sources: ['https://www.reviews.org/x'] })
  results.push(...loadResults(join(out, 'results.jsonl')))
  assert.throws(() => addManualAnswer({ outDir: out, engine: 'claude', id: 'P01', text: 'x' }), /not claude/)

  const score = scoreAudit({ prompts: PROMPTS, results, brands })
  assert.deepEqual(score.totals, { answers: 5, open: 4, brandAnswers: 1 })
  assert.deepEqual(score.perEngine, [
    { engine: 'chatgpt', answers: 1, mentioned: 1, first: 0, cited: 0 },
    { engine: 'claude', answers: 3, mentioned: 1, first: 1, cited: 1 },
  ])
  assert.deepEqual(score.share.map((s) => [s.name, s.answers]), [['Rival', 3], ['Example', 2], ['Other', 2]])
  assert.deepEqual(score.gapDomains, [{ key: 'list.com', count: 2 }, { key: 'rival.com', count: 1 }])
  assert.deepEqual(score.stability.map((p) => [p.id, p.engines.find((e) => e.engine === 'claude').runs]), [['P01', [false, true]]])

  const md = reportMarkdown(score, { generated: '2026-10-26' })
  assert.match(md, /^# GEO audit: Example\n/)
  assert.match(md, /\| claude \| 3 \| 1 \(33%\) \| 1 \| 1 \|/)
  assert.match(md, /\| \*\*Example\*\* \| 2 \|/)
  assert.match(md, /- P01 Best invoicing software\?: chatgpt Y, claude \.Y/)
  assert.match(md, /\| list\.com \| 2 \|/)
  assert.match(md, /\| P03 \| claude \| 1 \| yes \| Example \|/)
})

test('prompt file and brand config are validated', (t) => {
  const dir = tmp(t)
  const file = join(dir, 'p.json')
  const write = (v) => writeFileSync(file, JSON.stringify(v))
  write([{ id: 'A', text: 'x' }, { id: 'A', text: 'y' }])
  assert.throws(() => loadPrompts(file), /duplicate prompt id A/)
  write([{ id: 'A' }])
  assert.throws(() => loadPrompts(file), /needs an id and text/)
  assert.throws(() => brandsFrom({}), /audit\.brand\.name/)
  assert.ok(readFileSync(file, 'utf8'))
})

