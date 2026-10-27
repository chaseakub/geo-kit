// HTML to markdown for the agent-readable copy of every public page.
//
// geo-kit converts the HTML your build already wrote instead of asking you
// to keep a second, hand-written markdown copy. The second copy is the one
// that rots.
//
// Only the page's <main> is converted. Nav, footer, cookie banners and
// anything a visitor cannot see (hidden, aria-hidden, display:none) are left
// out, so the markdown never says more than the page does.
import TurndownService from 'turndown'

const decode = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'))
  return m ? decode(m[2] ?? m[3]) : null
}

function headTag(html, re) {
  const end = html.search(/<\/head>/i)
  const head = end === -1 ? html : html.slice(0, end)
  return head.match(re)?.[0] ?? null
}

// What the <head> says about the page: the facts every markdown header uses.
export function readHead(html) {
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '')
  const descTag = headTag(html, /<meta\s[^>]*name=["']description["'][^>]*>/i)
  const canonTag = headTag(html, /<link\s[^>]*rel=["']canonical["'][^>]*>/i)
  const robotsTag = headTag(html, /<meta\s[^>]*name=["']robots["'][^>]*>/i)
  return {
    title,
    description: descTag ? attr(descTag, 'content') : '',
    canonical: canonTag ? attr(canonTag, 'href') : null,
    noindex: robotsTag ? /noindex/i.test(attr(robotsTag, 'content') ?? '') : false,
  }
}

export function mainOf(html) {
  const start = html.search(/<main[\s>]/i)
  const end = html.lastIndexOf('</main>')
  if (start === -1 || end === -1) return null
  return html.slice(start, end + '</main>'.length)
}

function isHidden(node) {
  if (node.nodeType !== 1) return false
  if (node.hasAttribute('hidden')) return true
  if (node.getAttribute('aria-hidden') === 'true') return true
  const style = (node.getAttribute('style') || '').replace(/\s/g, '').toLowerCase()
  return style.includes('display:none') || style.includes('visibility:hidden')
}

const cellText = (s) => s.replace(/\s*\n+\s*/g, ' ').replace(/\|/g, '\\|').trim()

function absolute(href, pageUrl) {
  if (!href) return null
  if (/^(mailto|tel|sms):/i.test(href)) return href
  if (/^javascript:/i.test(href)) return null
  try {
    return new URL(href, pageUrl).href
  } catch {
    return null
  }
}

export function createConverter(pageUrl) {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
    hr: '---',
  })

  td.remove(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'video', 'audio',
    'nav', 'form', 'button', 'input', 'select', 'textarea', 'dialog', 'source'])
  td.addRule('hidden', { filter: isHidden, replacement: () => '' })

  td.addRule('link', {
    filter: (node) => node.nodeName === 'A' && node.getAttribute('href'),
    replacement(content, node) {
      const text = content.replace(/\s+/g, ' ').trim()
      const href = absolute(node.getAttribute('href'), pageUrl)
      if (!text) return ''
      return href ? `[${text}](${href})` : text
    },
  })

  td.addRule('image', {
    filter: 'img',
    replacement(_, node) {
      const alt = (node.getAttribute('alt') || '').trim()
      const src = absolute(node.getAttribute('src'), pageUrl)
      return alt && src ? `![${alt.replace(/[[\]]/g, '')}](${src})` : ''
    },
  })

  // A heading is one line. Display headings often break with <br> and inner
  // spans, which would otherwise split one heading across two lines.
  td.addRule('heading', {
    filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    replacement(content, node) {
      const text = content.replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim()
      return text ? `\n\n${'#'.repeat(Number(node.nodeName[1]))} ${text}\n\n` : ''
    },
  })
  td.addRule('br', { filter: 'br', replacement: () => ' ' })

  // FAQ blocks are usually <details>; the question reads best as a heading.
  td.addRule('summary', {
    filter: 'summary',
    replacement: (content) => `\n\n### ${content.replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim()}\n\n`,
  })

  // GFM tables. The parser turndown uses in Node has no querySelectorAll, so
  // rows are found by walking the tree (stopping at any nested table).
  const descendants = (node, name, out = []) => {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue
      if (child.nodeName === name) out.push(child)
      else if (child.nodeName !== 'TABLE') descendants(child, name, out)
    }
    return out
  }
  td.addRule('table', {
    filter: 'table',
    replacement(_, node) {
      const rows = descendants(node, 'TR')
        .map((tr) => [...tr.childNodes].filter((c) => c.nodeName === 'TH' || c.nodeName === 'TD'))
        .filter((cells) => cells.length)
      if (!rows.length) return ''
      const width = Math.max(...rows.map((r) => r.length))
      const line = (cells) => {
        const out = cells.map((c) => cellText(td.turndown(c.innerHTML)))
        while (out.length < width) out.push('')
        return `| ${out.join(' | ')} |`
      }
      const caption = descendants(node, 'CAPTION')[0]
      const head = caption ? `**${cellText(td.turndown(caption.innerHTML))}**\n\n` : ''
      const [first, ...rest] = rows
      return `\n\n${head}${line(first)}\n| ${Array(width).fill('---').join(' | ')} |\n${rest.map(line).join('\n')}\n\n`
    },
  })

  return td
}

export function tidy(md) {
  return md
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// " | Acme", " - Acme" and similar brand suffixes come off the title.
export function stripTitleSuffix(title, siteName) {
  if (!siteName) return title
  return title.replace(new RegExp(`\\s*[|·:\\-]\\s*${escapeRegExp(siteName)}\\s*$`, 'i'), '') || title
}

// One page to markdown. Returns null when the page has no <main>.
export function pageToMarkdown(html, { url, lastModified, siteName } = {}) {
  const head = readHead(html)
  const main = mainOf(html)
  if (main == null) return null

  // Adjacent inline elements ("<span>$69</span><span>per month</span>") sit
  // apart on screen through CSS; keep that gap in the text.
  const spaced = main.replace(/(<\/(?:span|strong|b|em|i|small|sup|sub|mark|time|data)>)(?=<[a-z])/gi, '$1 ')
  // The <title> is the document title, so the page's h1 steps down to h2.
  const body = tidy(createConverter(url).turndown(spaced)).replace(/^# /gm, '## ')
  const title = stripTitleSuffix(head.title, siteName)

  const lines = [`# ${title}`, '']
  if (head.description) lines.push(`> ${head.description}`, '')
  lines.push(`Canonical: ${url}`)
  if (lastModified) lines.push(`Last updated: ${lastModified}`)
  lines.push('', body)
  return { title, description: head.description, noindex: head.noindex, markdown: `${tidy(lines.join('\n'))}\n` }
}

// Markdown tokens are estimated the usual way, four characters per token.
export const approxTokens = (text) => Math.ceil(text.length / 4)
