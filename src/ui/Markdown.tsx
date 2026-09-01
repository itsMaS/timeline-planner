import React from 'react'

/** Minimal markdown: **bold**, *italic*, `code`, [text](url), - lists, line breaks. */
function inline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const re = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)\s]+)\))/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    if (m[2]) out.push(<strong key={`${keyBase}b${k++}`}>{m[2]}</strong>)
    else if (m[4]) out.push(<em key={`${keyBase}i${k++}`}>{m[4]}</em>)
    else if (m[6]) out.push(<code key={`${keyBase}c${k++}`}>{m[6]}</code>)
    else if (m[8]) out.push(
      <a key={`${keyBase}a${k++}`} href={m[9]} target="_blank" rel="noreferrer noopener">{m[8]}</a>,
    )
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function Markdown({ text }: { text: string }) {
  const lines = text.split('\n')
  const blocks: React.ReactNode[] = []
  let listBuf: string[] = []
  const flushList = (key: string) => {
    if (!listBuf.length) return
    blocks.push(
      <ul key={key}>{listBuf.map((li, i) => <li key={i}>{inline(li, `${key}-${i}`)}</li>)}</ul>,
    )
    listBuf = []
  }
  lines.forEach((line, i) => {
    const li = line.match(/^\s*[-*]\s+(.*)$/)
    if (li) { listBuf.push(li[1]); return }
    flushList(`l${i}`)
    if (line.trim() === '') return
    blocks.push(<p key={`p${i}`}>{inline(line, `p${i}`)}</p>)
  })
  flushList('lEnd')
  return <div className="md">{blocks}</div>
}
