import { renderAst } from './ast.ts'
import { renderHandlebars } from './handlebars.ts'
import { decodeEntities, parseAttrs } from './html.ts'
import { inlineCss } from './inline.ts'
import { renderMjml } from './mjml.ts'
import type { Engine, RenderOptions, RenderResult, RenderWarning } from './types.ts'
import { warn } from './types.ts'

/**
 * The one entry point. Everything upstream — the send path, broadcast fan-out,
 * the dashboard preview — calls this and nothing else, so that a template
 * renders identically whichever of them is asking.
 */

export interface RenderTemplateInput {
  engine: Engine
  subject?: string | null
  /** Template body. For `mjml` this is the MJML source. */
  html?: string | null
  /** Author-supplied text part. Generated from the HTML when absent. */
  text?: string | null
  /** The `jsx-ast` document, as stored in `template_versions.ast`. */
  ast?: unknown
  data?: Record<string, unknown>
  options?: RenderOptions
}

/**
 * Gmail truncates a message past ~102KB and shows a "View entire message"
 * link. Everything after the cut is invisible — including, in practice, the
 * unsubscribe footer and the open pixel, so a clipped broadcast under-reports
 * opens and over-reports spam complaints.
 */
const GMAIL_CLIP_BYTES = 102_000

/** RFC 5322 caps a header line, and clients truncate a subject long before that. */
const SUBJECT_DISPLAY_LIMIT = 150

export const renderTemplate = async (input: RenderTemplateInput): Promise<RenderResult> => {
  const options = input.options ?? {}
  const data = input.data ?? {}
  const warnings: RenderWarning[] = []

  // The subject is rendered as plain text, never as HTML: it ends up in a MIME
  // header, where `&amp;` would be shown to the recipient literally.
  const subjectSource = input.subject ?? ''
  const subject =
    subjectSource === ''
      ? ''
      : collect(warnings, renderHandlebars(subjectSource, { data, options, escape: false }))

  if (subject.trim() === '') {
    warnings.push(warn('subject_missing', 'The message has no subject line.'))
  } else if (subject.length > SUBJECT_DISPLAY_LIMIT) {
    warnings.push(
      warn(
        'subject_too_long',
        `Subject is ${subject.length} characters; most clients show under 80.`,
      ),
    )
  }

  let html = await renderBody(input, data, options, warnings)

  if (options.inlineCss !== false && html.includes('<style')) {
    const inlined = inlineCss(html)
    html = inlined.html
    warnings.push(...inlined.warnings)
  }

  if (html.trim() === '') warnings.push(warn('empty_html', 'The rendered HTML body is empty.'))

  if (new TextEncoder().encode(html).byteLength > GMAIL_CLIP_BYTES) {
    warnings.push(warn('gmail_clipping', 'HTML exceeds ~102KB and Gmail will clip it.'))
  }

  let text = input.text ?? ''
  if (text !== '') {
    text = collect(warnings, renderHandlebars(text, { data, options, escape: false }))
  } else if (options.generateText !== false && html !== '') {
    text = htmlToText(html)
    warnings.push(
      warn('text_generated', 'No text part was supplied; one was derived from the HTML.'),
    )
  }

  return { subject, html, text, warnings }
}

const collect = (
  warnings: RenderWarning[],
  result: { output: string; warnings: RenderWarning[] },
): string => {
  warnings.push(...result.warnings)
  return result.output
}

const hasHandlebarsPlaceholder = (source: string): boolean => {
  let cursor = 0
  while (cursor < source.length) {
    const start = source.indexOf('{{', cursor)
    if (start === -1) return false
    let close = start + 2
    while (close < source.length && source[close] !== '}') close++
    if (close === source.length) return false
    if (source[close + 1] === '}') {
      if (close > start + 2) return true
      cursor = close + 1
    } else {
      // A single `}` makes this candidate invalid, and no candidate before
      // it can be valid either. Continue after it to keep this linear.
      cursor = close + 1
    }
  }
  return false
}

const renderBody = async (
  input: RenderTemplateInput,
  data: Record<string, unknown>,
  options: RenderOptions,
  warnings: RenderWarning[],
): Promise<string> => {
  switch (input.engine) {
    case 'handlebars':
      return input.html ? collect(warnings, renderHandlebars(input.html, { data, options })) : ''

    case 'jsx-ast': {
      const result = renderAst(input.ast, data, options)
      warnings.push(...result.warnings)
      return result.html
    }

    case 'mjml': {
      // MJML output is ordinary HTML that may still carry merge tags, so the
      // Handlebars pass runs after compilation rather than before it — MJML's
      // own parser would otherwise choke on `{{#if}}` around an `<mj-column>`.
      const compiled = await renderMjml(input.html ?? '')
      warnings.push(...compiled.warnings)
      return collect(warnings, renderHandlebars(compiled.html, { data, options }))
    }

    case 'html': {
      // Raw, by definition: the `html` engine exists for bodies produced
      // elsewhere and stored verbatim. Merge tags left in one are a mistake
      // worth reporting rather than silently interpreting, because interpreting
      // them would change what an already-approved body renders as.
      const raw = input.html ?? ''
      if (hasHandlebarsPlaceholder(raw)) {
        warnings.push(
          warn(
            'raw_html_placeholders',
            'The `html` engine does not interpolate; use `handlebars`.',
          ),
        )
      }
      return raw
    }
  }
}

// ---------------------------------------------------------------------------
// HTML to text
// ---------------------------------------------------------------------------

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'div',
  'dd',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'tfoot',
  'thead',
  'tr',
  'ul',
])

const DROPPED_TAGS = ['script', 'style', 'head', 'title', 'noscript'] as const

const isAsciiWord = (char: string | undefined): boolean =>
  char !== undefined &&
  ((char >= 'a' && char <= 'z') ||
    (char >= 'A' && char <= 'Z') ||
    (char >= '0' && char <= '9') ||
    char === '_')

const isHtmlWhitespace = (char: string | undefined): boolean =>
  char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f'

const stripHtmlComments = (html: string): string => {
  let output = ''
  let cursor = 0
  while (cursor < html.length) {
    const start = html.indexOf('<!--', cursor)
    if (start === -1) return output + html.slice(cursor)
    const close = html.indexOf('-->', start + 4)
    if (close === -1) return output + html.slice(cursor)
    output += html.slice(cursor, start)
    cursor = close + 3
  }
  return output
}

const findDroppedClose = (source: string, lower: string, name: string, from: number): number => {
  const marker = `</${name}`
  let start = lower.indexOf(marker, from)
  while (start !== -1) {
    let cursor = start + marker.length
    while (isHtmlWhitespace(source[cursor])) cursor++
    if (source[cursor] === '>') return cursor + 1
    start = lower.indexOf(marker, start + 2)
  }
  return -1
}

const stripDroppedContent = (html: string): string => {
  const lower = html.toLowerCase()
  let output = ''
  let cursor = 0
  let searchFrom = 0

  while (searchFrom < html.length) {
    const start = lower.indexOf('<', searchFrom)
    if (start === -1) return output + html.slice(cursor)

    let name: (typeof DROPPED_TAGS)[number] | undefined
    for (const candidate of DROPPED_TAGS) {
      if (!lower.startsWith(candidate, start + 1)) continue
      if (isAsciiWord(lower[start + 1 + candidate.length])) continue
      name = candidate
      break
    }
    if (name === undefined) {
      searchFrom = start + 1
      continue
    }

    const openEnd = lower.indexOf('>', start + name.length + 1)
    if (openEnd === -1) {
      searchFrom = start + 1
      continue
    }
    const closeEnd = findDroppedClose(html, lower, name, openEnd + 1)
    if (closeEnd === -1) {
      searchFrom = start + 1
      continue
    }

    output += html.slice(cursor, start)
    cursor = closeEnd
    searchFrom = closeEnd
  }

  return output + html.slice(cursor)
}

/**
 * Strip all dangerous structures, repeating until stable so a nested opener
 * exposed by one removal cannot survive into the text parser.
 */
const sanitizeHtmlForText = (html: string): string => {
  let source = html
  while (true) {
    const next = stripDroppedContent(stripHtmlComments(source))
    if (next === source) return source
    source = next
  }
}

/** Preheaders and the MSO ghost tables are hidden on purpose; keep them hidden. */
const HIDDEN_BLOCK =
  /<(div|span|td|table|p)\b[^>]*style\s*=\s*("[^"]*|'[^']*)display\s*:\s*none[\s\S]*?<\/\1\s*>/gi

export const htmlToText = (html: string): string => {
  let source = sanitizeHtmlForText(html)
  // Run twice: a hidden preheader is often nested one level inside another
  // hidden wrapper, and this regex is not recursive.
  source = source.replace(HIDDEN_BLOCK, '').replace(HIDDEN_BLOCK, '')

  let out = ''
  let cursor = 0
  /** href of the anchor we are inside, and where its label started. */
  let link: { href: string; at: number } | null = null

  const push = (chunk: string) => {
    out += chunk
  }

  // Whitespace in the source is collapsed as each text run is appended, so that
  // a newline the author used to wrap their markup does not become a paragraph
  // break in the text part. Only tag boundaries produce newlines.
  const pushText = (chunk: string) => {
    if (chunk !== '') push(chunk.replace(/\s+/g, ' '))
  }

  const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:'[^']*'|"[^"]*"|[^>'"])*?)\/?>/g
  for (let match = TAG_RE.exec(source); match !== null; match = TAG_RE.exec(source)) {
    pushText(source.slice(cursor, match.index))
    cursor = match.index + match[0].length

    const closing = match[1] === '/'
    const name = (match[2] as string).toLowerCase()
    const attrs = match[3] ?? ''

    if (name === 'br') {
      push('\n')
    } else if (name === 'img' && !closing) {
      const alt = parseAttrs(attrs).get('alt')
      if (alt !== undefined && alt.trim() !== '') push(`[${alt}] `)
    } else if (name === 'li' && !closing) {
      // The opening tag carries the break; `li` is deliberately absent from
      // BLOCK_TAGS so the close does not add a second one.
      push('\n- ')
    } else if (name === 'hr') {
      push('\n\n---\n\n')
    } else if (name === 'td' || name === 'th') {
      // A layout table's cells are usually stacked content, not columns, so a
      // space is closer to the intent than a tab would be.
      if (closing) push(' ')
    } else if (name === 'a') {
      if (!closing) {
        const href = parseAttrs(attrs).get('href') ?? ''
        link = { href: href.trim(), at: out.length }
      } else if (link !== null) {
        const label = decodeEntities(out.slice(link.at)).replace(/\s+/g, ' ').trim()
        const href = link.href
        const bare =
          href === '' ||
          href.startsWith('#') ||
          href.startsWith('mailto:') ||
          /\{\{|%\w+%/.test(href) ||
          label === href ||
          `mailto:${label}` === href
        if (!bare) push(` (${href})`)
        link = null
      }
    } else if (BLOCK_TAGS.has(name)) {
      push('\n\n')
    }
  }
  pushText(source.slice(cursor))

  return decodeEntities(out)
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim()
}
