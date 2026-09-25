import { Fragment, type ReactNode } from 'react'
import { parseBlocks } from './format'

/** `**bold**` as <strong>; an unmatched pair of stars stays as typed. */
function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const pattern = /\*\*(.+?)\*\*/g
  let from = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > from) out.push(text.slice(from, match.index))
    out.push(<strong key={match.index} className="font-semibold">{match[1]}</strong>)
    from = match.index + match[0].length
  }
  if (from < text.length) out.push(text.slice(from))
  return out
}

/**
 * The model's words, drawn safely. Only paragraphs, line breaks, **bold** and simple `-` or `1.`
 * lists are understood; everything else stays as the plain text it is. Nothing is ever read as
 * HTML: every piece becomes a React text node.
 */
export function AnswerText({ text }: { text: string }) {
  const blocks = parseBlocks(text)
  if (blocks.length === 0) return null
  return (
    <div className="flex flex-col gap-2.5 text-[13.5px] leading-relaxed break-words">
      {blocks.map((block, i) => {
        if (block.kind === 'bullets') {
          return <ul key={i} className="flex list-disc flex-col gap-1 pl-5 marker:text-muted-foreground">{block.items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}</ul>
        }
        if (block.kind === 'numbers') {
          return <ol key={i} start={block.start} className="flex list-decimal flex-col gap-1 pl-5 marker:text-muted-foreground">{block.items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}</ol>
        }
        return (
          <p key={i}>
            {block.lines.map((line, j) => <Fragment key={j}>{j > 0 && <br />}{renderInline(line)}</Fragment>)}
          </p>
        )
      })}
    </div>
  )
}
