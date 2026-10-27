# geo-kit

Make your site readable by answer engines, then measure whether they actually name you.

Two halves:

1. **Readable.** `geo-kit build` runs after your static build and gives every page a clean markdown copy, plus the files agents look for: `llms.txt`, `llms-full.txt`, `ai.txt` and a page catalog. A small middleware serves markdown to agents that ask for it, and an optional MCP server lets agents list, read and search your pages directly. Browsers keep getting your HTML, untouched.
2. **Measured.** `geo-kit audit` asks Claude (with live web search) the questions your buyers ask, records every answer, and reports how often you were mentioned, named first and cited, your share of voice against competitors, and which sources the engines read when they left you out.

Extracted from [Replio](https://www.repliohq.com), where this code serves every public page.

## Quick start

```bash
npm install --save-dev geo-kit
npx geo-kit init            # writes geo.config.mjs and a sample geo-prompts.json
```

Set `site` in `geo.config.mjs`, then chain the build after yours:

```json
"build": "vite build && geo-kit build"
```

Your build output needs a `sitemap.xml` and pages with a `<main>` element. That is all geo-kit reads.

## What `geo-kit build` writes

For every URL in `sitemap.xml`:

| File | What it is |
| --- | --- |
| `/<path>.md` | The page's `<main>` as markdown: visible text only, links made absolute, tables kept, FAQ `<details>` turned into headings. Header carries the title, description, canonical URL and last-updated date. |
| `<link rel="alternate" type="text/markdown">` | Added to each page's `<head>`, with an `ai-summary` meta tag. The page body is never changed. |

Site-level:

| File | What it is |
| --- | --- |
| `/llms.txt` | Yours, with page links pointed at their `.md` copies and a machine-readable section added. If you don't have one, it is generated from your pages. |
| `/llms-full.txt` | Every page in one file, most important first, under a size budget (500,000 characters by default). Pages that don't fit are listed by URL so nothing is hidden. |
| `/ai.txt` | How answer engines may quote, cite and attribute you ([ai-txt v1.1.1](https://www.ai-visibility.org.uk/specifications/ai-txt/)), with sane default restrictions: no invented quotes, numbers or prices. |
| `/md-catalog.json` | Every markdown route as JSON. |
| `/.well-known/mcp.json` | MCP discovery, when you run the MCP endpoint. |

The sitemap is the route registry on purpose. A page you publish is already in it, so it gets its markdown copy with no second step. The build fails loudly instead of shipping a bad copy: a page with no `<main>`, a page that converts to almost nothing, or a `noindex` page in the sitemap. Exclude a page with `skip` and say why.

## Serving markdown (Vercel)

```bash
npx geo-kit init vercel     # writes middleware.js and api/mcp.js
```

`middleware.js` answers:

```
GET /pricing.md                          the copy
GET /pricing  Accept: text/markdown      the copy, only when markdown is preferred over HTML
GET /api/md/pricing                      the copy (handy for debugging)
GET /api/md/_catalog                     the catalog
```

Browsers, `curl` with `*/*` and link previews always get HTML. If the middleware ever errors, it falls through to your page, so it can't take your site down.

The middleware is a plain Web `Request` in, `Response` or `undefined` out, so it ports to Cloudflare, Netlify or any edge runtime:

```js
import { createMarkdownMiddleware } from 'geo-kit/middleware'
const markdown = createMarkdownMiddleware({ site: 'https://www.example.com' })
```

On a host with no middleware at all, the `.md` files are still static files and `llms.txt` still points at them.

## MCP server

`api/mcp.js` is a stateless, read-only [Model Context Protocol](https://modelcontextprotocol.io) endpoint with three tools: `list_pages`, `get_page` and `search_pages` (a small BM25 over titles, descriptions and full text). It can only return what your public catalog already lists, needs no key, and rate-limits per IP. Turn on discovery with `mcp: { endpoint: '/api/mcp' }` in the config.

For other runtimes, `createMcpServer` from `geo-kit/mcp` takes JSON-RPC messages and three loader functions, with no network code of its own.

## Measuring: `geo-kit audit`

Write the questions your buyers actually ask in `geo-prompts.json`. Tag each with a topic. Include category questions ("best X for Y"), job-to-be-done questions, comparisons, alternatives and pricing. A few that name you are fine; they're scored separately.

```json
[{ "id": "P01", "topic": "category", "text": "What is the best invoicing software for freelancers?" }]
```

List yourself and your competitors in the config:

```js
audit: {
  brand: { name: 'Example', aliases: ['Example App'], domains: ['example.com'] },
  competitors: [{ name: 'Rival', domains: ['rival.com'] }],
}
```

Then:

```bash
export ANTHROPIC_API_KEY=...       # or `ant auth login`
npx geo-kit audit run --runs 3     # each answer is a billed API call with up to 5 web searches
npx geo-kit audit score            # writes geo-audit/report.md
```

`run` resumes: answers already in `geo-audit/results.jsonl` are skipped, so a failed or interrupted run just picks up where it stopped. Every raw API response is kept in `geo-audit/raw/`.

Other engines don't have an API that behaves like their consumer app, so collect those answers by hand (a private or temporary chat, signed out where you can) and add them:

```bash
pbpaste | npx geo-kit audit add --engine chatgpt --id P01 --source https://cited.example/page
```

### What the report tells you

- **Scoreboard per engine:** mentioned, named first, your site cited.
- **Share of voice:** answers that mention each brand.
- **By topic:** where you show up and where you don't.
- **Repeat stability:** answers change run to run. One run is an anecdote; three is a pattern.
- **Where engines looked when they left you out:** the domains and pages cited in answers that skipped you. This is your outreach list.

Mentions are matched by name and alias, citations by domain. No model grades another model, so every number traces back to a line in `results.jsonl`.

### What we learned running this

- **Engines read listicles.** They rewrite most questions into "best X 2026" searches and answer from the top few roundup posts. If you aren't in those, your own pages rarely save you. The gap list in the report is where the real work is.
- **You win your exact job and lose the category.** It's common to be named first for a precise description of what you do and never for "best X software". Measure both.
- **Self-ranking gets discounted.** A list on your own site that ranks you first gets called out as such. Independent reviews (G2, Capterra, Reddit threads) move answers more than another page of your own.
- **Stale copies linger.** Engines can quote an old price from a cached copy of your page. Keep `Last updated` dates honest and ping IndexNow when facts change.
- **Name collisions are real.** If another product shares your name, say so in `aiTxt.notToBeConfusedWith`.

## Config reference

```js
export default {
  site: 'https://www.example.com',   // required
  dist: 'dist',                      // build output with sitemap.xml
  name, description, legalName,      // default: homepage Organization JSON-LD, then <title>/meta
  foundingDate, location,
  skip: { '/path': 'reason' },       // sitemap pages with no markdown copy
  core: ['/', '/pricing'],           // first in llms-full.txt
  last: ['/privacy', '/terms'],      // last in llms-full.txt
  notInFull: ['/contact'],           // catalogued, but not in llms-full.txt
  fullLimit: 500_000,                // llms-full.txt size budget in characters
  minWords: 40,                      // a page shorter than this fails the build
  summaries: { '/pricing': '...' },  // ai-summary meta per page (default: meta description)
  mcp: { endpoint: '/api/mcp' },
  aiTxt: {
    contact: 'hello@example.com',
    excludes: ['/api/'],
    notToBeConfusedWith: '...',
    restrictions: ['...'],           // added to the defaults
    replaceRestrictions: false,      // true to use only yours
    training: true,                  // false to state training is not permitted
  },
  audit: { prompts: 'geo-prompts.json', out: 'geo-audit', brand: {...}, competitors: [...] },
}
```

## Requirements

Node 20+. The build and middleware have one dependency ([turndown](https://github.com/mixmark-io/turndown)); the audit uses the official Anthropic SDK.

## License

MIT, Chase Kubala.
