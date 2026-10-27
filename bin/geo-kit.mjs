#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { addManualAnswer, brandsFrom, DEFAULT_MODEL, loadPrompts, loadResults, reportMarkdown, runAudit, scoreAudit } from '../src/audit.mjs'
import { buildMarkdown } from '../src/build.mjs'
import { CONFIG_FILE, loadConfig } from '../src/config.mjs'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const HELP = `geo-kit: make your site readable by answer engines, then measure whether they name you.

Usage
  geo-kit init [vercel]        write geo.config.mjs (and, with vercel, middleware.js + api/mcp.js)
  geo-kit build                after your site build: .md copies, llms.txt, llms-full.txt, ai.txt, catalog
  geo-kit audit run            ask Claude (with web search) every prompt in your prompt file
  geo-kit audit add            record an answer from another engine (text on stdin)
  geo-kit audit score          write the audit report from results.jsonl

Options
  --config <file>              config file (default ${CONFIG_FILE})
  --runs <n>                   audit run: repeats per prompt (default 1)
  --model <id>                 audit run: Claude model (default ${DEFAULT_MODEL})
  --concurrency <n>            audit run: parallel requests (default 4)
  --engine <name> --id <id>    audit add: where the answer came from, and its prompt id
  --run <n> --source <url>     audit add: run number (default 1); repeat --source per cited URL
  -h, --help

Docs: https://github.com/chaseakub/geo-kit`

const CONFIG_TEMPLATE = `// geo-kit configuration. Every field but \`site\` is optional.
export default {
  site: 'https://www.example.com',
  dist: 'dist', // your static build output; must contain sitemap.xml

  // name and description default to the homepage Organization JSON-LD,
  // then its <title> and meta description.
  // name: 'Example',
  // description: 'One plain sentence about what you do.',

  // Sitemap pages that get no markdown copy, each with its reason.
  skip: {
    // '/thank-you': 'Form confirmation, nothing to read.',
  },

  // llms-full.txt order: these first, \`last\` at the end, the rest by sitemap priority.
  core: ['/', '/about', '/pricing'],
  last: ['/privacy', '/terms'],

  // Set when you deploy the MCP endpoint (geo-kit init vercel writes api/mcp.js).
  // mcp: { endpoint: '/api/mcp' },

  aiTxt: {
    contact: 'hello@example.com',
    excludes: ['/api/'],
    // notToBeConfusedWith: 'example.net, or any other product named Example',
    // restrictions: ['Any extra rule for answer engines.'],
  },

  audit: {
    prompts: 'geo-prompts.json',
    out: 'geo-audit',
    brand: { name: 'Example', aliases: [], domains: ['example.com'] },
    competitors: [
      // { name: 'Rival', domains: ['rival.com'] },
    ],
  },
}
`

function fail(message) {
  console.error(message)
  process.exit(1)
}

function writeOnce(path, contents) {
  if (existsSync(path)) {
    console.log(`  kept ${path} (already exists)`)
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
  console.log(`  wrote ${path}`)
}

async function init(target, cwd) {
  writeOnce(join(cwd, CONFIG_FILE), CONFIG_TEMPLATE)
  if (!existsSync(join(cwd, 'geo-prompts.json'))) {
    copyFileSync(join(pkgRoot, 'examples', 'geo-prompts.json'), join(cwd, 'geo-prompts.json'))
    console.log(`  wrote ${join(cwd, 'geo-prompts.json')} (replace these with your buyers' questions)`)
  }
  if (target === 'vercel') {
    const site = existsSync(join(cwd, CONFIG_FILE)) ? (await loadConfig(CONFIG_FILE, cwd)).site : 'https://www.example.com'
    const fill = (file) => readFileSync(join(pkgRoot, 'templates', 'vercel', file), 'utf8').replaceAll('__SITE__', site).replaceAll('__NAME__', new URL(site).host.replace(/^www\./, ''))
    writeOnce(join(cwd, 'middleware.js'), fill('middleware.js'))
    writeOnce(join(cwd, 'api', 'mcp.js'), fill(join('api', 'mcp.js')))
    console.log('\nNext: set mcp: { endpoint: \'/api/mcp\' } in geo.config.mjs, and add `&& geo-kit build` to the end of your build script.')
  } else if (target) {
    fail(`geo-kit: unknown init target "${target}". Supported: vercel.`)
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return ''
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', default: CONFIG_FILE },
      runs: { type: 'string', default: '1' },
      model: { type: 'string', default: DEFAULT_MODEL },
      concurrency: { type: 'string', default: '4' },
      engine: { type: 'string' },
      id: { type: 'string' },
      run: { type: 'string', default: '1' },
      source: { type: 'string', multiple: true, default: [] },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const [command, sub] = positionals
  const cwd = process.cwd()
  if (values.help || !command) return console.log(HELP)

  if (command === 'init') return init(sub, cwd)

  const config = await loadConfig(values.config, cwd)

  if (command === 'build') {
    const { pages, fullChars, llmsGenerated } = buildMarkdown(config, { log: console.warn })
    console.log(`geo-kit: ${pages} markdown pages, llms-full.txt ${fullChars.toLocaleString('en-US')} characters, ai.txt and md-catalog.json written${llmsGenerated ? ', llms.txt generated' : ', llms.txt extended'}.`)
    return
  }

  if (command === 'audit') {
    if (!config.audit) fail('geo-kit: add an audit section to geo.config.mjs (see `geo-kit init`).')
    const out = resolve(cwd, config.audit.out)
    const prompts = loadPrompts(resolve(cwd, config.audit.prompts))
    const brands = brandsFrom(config.audit)

    if (sub === 'run') {
      const { default: Anthropic } = await import('@anthropic-ai/sdk')
      const runs = Number(values.runs)
      const concurrency = Number(values.concurrency)
      if (!Number.isInteger(runs) || runs < 1) fail('geo-kit: --runs must be a whole number of 1 or more.')
      console.log(`geo-kit audit: ${prompts.length} prompts x ${runs} run${runs === 1 ? '' : 's'} on ${values.model}. Each answer is a billed API call with up to 5 web searches.`)
      const { failed } = await runAudit({ prompts, outDir: out, runs, model: values.model, concurrency, client: new Anthropic(), log: console.log })
      console.log(`Done. Answers are in ${join(out, 'results.jsonl')}. Next: geo-kit audit score${failed ? ` (${failed} failed; run again to retry them)` : ''}`)
      if (failed) process.exitCode = 1
      return
    }

    if (sub === 'add') {
      if (!values.engine || !values.id) fail('geo-kit: audit add needs --engine and --id, with the answer text on stdin.')
      if (!prompts.some((p) => p.id === values.id)) fail(`geo-kit: no prompt with id ${values.id} in ${config.audit.prompts}.`)
      const row = addManualAnswer({ outDir: out, engine: values.engine, id: values.id, run: Number(values.run), text: await readStdin(), sources: values.source })
      console.log(`Recorded ${row.engine} ${row.id} run ${row.run} (${row.text.length} chars, ${row.cited.length} sources).`)
      return
    }

    if (sub === 'score') {
      const results = loadResults(join(out, 'results.jsonl'))
      if (!results.length) fail(`geo-kit: no answers in ${join(out, 'results.jsonl')} yet. Run geo-kit audit run first.`)
      const report = reportMarkdown(scoreAudit({ prompts, results, brands }))
      writeFileSync(join(out, 'report.md'), report)
      console.log(report)
      console.log(`Saved to ${join(out, 'report.md')}`)
      return
    }
    fail('geo-kit: audit needs run, add or score.')
  }

  fail(`geo-kit: unknown command "${command}".\n\n${HELP}`)
}

main().catch((error) => fail(error.message))
