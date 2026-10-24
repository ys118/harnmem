import { Fragment, type ReactNode } from 'react'

/**
 * Minimal, XSS-safe markdown renderer.
 *
 * The panel must never inject raw HTML strings, so markdown is parsed
 * into React nodes here. Supported: fenced code, ATX headings, ordered and
 * unordered lists (one nesting level chain via indentation), blockquotes,
 * pipe tables, horizontal rules, paragraphs and inline code / bold / italic /
 * links / `[[wiki links]]`. Raw HTML is intentionally *not* supported and is
 * rendered as text.
 */

const INLINE_PATTERN =
  /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\([^)\s]+\)|\[\[[^\]\n]+\]\])/g

const SAFE_LINK = /^(?:https?:\/\/|mailto:|\/|\.{0,2}\/|#)/i
const BLOCK_START = /^(?:#{1,6}\s|>\s?|```|~~~|\s*[-*+]\s+|\s*\d+[.)]\s+|\s*\|)/

/** Render markdown source as React nodes. */
export function Markdown({ text, className }: { text: string; className?: string }): ReactNode {
  return <div className={className ? `dshh-md ${className}` : 'dshh-md'}>{renderBlocks(text.split(/\r?\n/))}</div>
}

function renderBlocks(lines: string[]): ReactNode[] {
  const out: ReactNode[] = []
  let index = 0
  let key = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (!line.trim()) {
      index += 1
      continue
    }

    const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line)
    if (fence) {
      const marker = fence[1] ?? '```'
      const language = fence[2] ?? ''
      const body: string[] = []
      index += 1
      while (index < lines.length && !(lines[index] ?? '').trimStart().startsWith(marker)) {
        body.push(lines[index] ?? '')
        index += 1
      }
      index += 1
      out.push(
        <pre key={`code-${key++}`} className="dshh-md-pre" data-language={language || undefined}>
          <code>{body.join('\n')}</code>
        </pre>,
      )
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = Math.min(6, heading[1]?.length ?? 1)
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      out.push(
        <Tag key={`h-${key++}`} className="dshh-md-heading">
          {renderInline(heading[2] ?? '', `h-${key}`)}
        </Tag>,
      )
      index += 1
      continue
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(<hr key={`hr-${key++}`} className="dshh-md-hr" />)
      index += 1
      continue
    }

    if (/^\s*>/.test(line)) {
      const quote: string[] = []
      while (index < lines.length && /^\s*>/.test(lines[index] ?? '')) {
        quote.push((lines[index] ?? '').replace(/^\s*>\s?/, ''))
        index += 1
      }
      out.push(
        <blockquote key={`quote-${key++}`} className="dshh-md-quote">
          {renderBlocks(quote)}
        </blockquote>,
      )
      continue
    }

    if (isTableStart(lines, index)) {
      const table = consumeTable(lines, index)
      out.push(
        <table key={`table-${key++}`} className="dshh-md-table">
          <thead>
            <tr>
              {table.header.map((cell, cellIndex) => (
                <th key={cellIndex}>{renderInline(cell, `th-${cellIndex}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>{renderInline(cell, `td-${rowIndex}-${cellIndex}`)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      )
      index = table.next
      continue
    }

    if (isListStart(lines, index)) {
      const items = consumeListItems(lines, index)
      const [node, next] = renderList(items.items, 0, 0, `list-${key++}`)
      out.push(<Fragment key={`list-wrap-${key}`}>{node}</Fragment>)
      index = items.next
      continue
    }

    const paragraph: string[] = []
    while (index < lines.length) {
      const current = lines[index] ?? ''
      if (!current.trim()) break
      if (paragraph.length > 0 && BLOCK_START.test(current)) break
      paragraph.push(current.trim())
      index += 1
    }
    out.push(
      <p key={`p-${key++}`} className="dshh-md-p">
        {renderInline(paragraph.join(' '), `p-${key}`)}
      </p>,
    )
  }

  return out
}

interface ListItem {
  level: number
  ordered: boolean
  text: string
}

function isListStart(lines: string[], index: number): boolean {
  return /^(\s*)([-*+]|\d+[.)])\s+/.test(lines[index] ?? '')
}

function consumeListItems(lines: string[], start: number): { items: ListItem[]; next: number } {
  const items: ListItem[] = []
  let index = start
  while (index < lines.length) {
    const line = lines[index] ?? ''
    const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (!match) break
    const indent = match[1]?.length ?? 0
    items.push({
      level: Math.floor(indent / 2),
      ordered: /\d/.test(match[2] ?? ''),
      text: match[3] ?? '',
    })
    index += 1
  }
  return { items, next: index }
}

function renderList(
  items: ListItem[],
  start: number,
  baseLevel: number,
  prefix: string,
): [ReactNode, number] {
  const first = items[start]
  const ordered = first?.ordered ?? false
  const nodes: ReactNode[] = []
  let index = start

  while (index < items.length) {
    const item = items[index]
    if (!item || item.level < baseLevel) break
    if (item.level > baseLevel) {
      // Unexpectedly deep item: treat it as a sibling at this level.
      item.level = baseLevel
    }
    const inline = renderInline(item.text, `${prefix}-${index}`)
    const children: ReactNode[] = [inline]
    index += 1
    if (index < items.length && (items[index]?.level ?? baseLevel) > baseLevel) {
      const deeper = items[index]?.level ?? baseLevel
      const [sublist, next] = renderList(items, index, deeper, `${prefix}-${index}`)
      children.push(<Fragment key={`${prefix}-sub-${index}`}>{sublist}</Fragment>)
      index = next
    }
    nodes.push(<li key={`${prefix}-item-${index}`}>{children}</li>)
  }

  const node = ordered ? (
    <ol className="dshh-md-list">{nodes}</ol>
  ) : (
    <ul className="dshh-md-list">{nodes}</ul>
  )
  return [node, index]
}

function isTableStart(lines: string[], index: number): boolean {
  const head = lines[index] ?? ''
  const separator = lines[index + 1] ?? ''
  return head.includes('|') && /^\s*\|?\s*:?-{2,}/.test(separator)
}

function consumeTable(
  lines: string[],
  start: number,
): { header: string[]; rows: string[][]; next: number } {
  const header = splitRow(lines[start] ?? '')
  const rows: string[][] = []
  let index = start + 2
  while (index < lines.length && (lines[index] ?? '').includes('|') && (lines[index] ?? '').trim()) {
    rows.push(splitRow(lines[index] ?? ''))
    index += 1
  }
  return { header, rows, next: index }
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let cursor = 0
  let piece = 0
  // A fresh matcher per invocation: renderToken recurses into renderInline for
  // bold/italic/link labels, and a shared global regex would have its lastIndex
  // clobbered by the nested scan (which can make the outer loop revisit tokens
  // forever). Keeping the scan cursor local is what makes this re-entrant.
  const pattern = new RegExp(INLINE_PATTERN.source, 'g')
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index))
    }
    const token = match[0]
    const key = `${keyPrefix}-${piece++}`
    nodes.push(renderToken(token, key))
    cursor = match.index + token.length
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

function renderToken(token: string, key: string): ReactNode {
  if (token.startsWith('`')) {
    return (
      <code key={key} className="dshh-md-code">
        {token.slice(1, -1)}
      </code>
    )
  }
  if (token.startsWith('**') || token.startsWith('__')) {
    return <strong key={key}>{renderInline(token.slice(2, -2), key)}</strong>
  }
  if (token.startsWith('*') || token.startsWith('_')) {
    return <em key={key}>{renderInline(token.slice(1, -1), key)}</em>
  }
  if (token.startsWith('[[')) {
    return (
      <span key={key} className="dshh-md-wikilink">
        {token.slice(2, -2)}
      </span>
    )
  }
  const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)
  if (link) {
    const label = link[1] ?? ''
    const href = link[2] ?? ''
    if (!SAFE_LINK.test(href)) return <span key={key}>{label}</span>
    return (
      <a key={key} className="dshh-link" href={href} target="_blank" rel="noreferrer noopener">
        {label}
      </a>
    )
  }
  return <Fragment key={key}>{token}</Fragment>
}
