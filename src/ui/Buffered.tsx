import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * Text that is typed locally and committed to the document after a short
 * pause (and on blur, Enter-to-next, switching entity or unmount). Every
 * commit is a full `mutate`: clone, diff, history, sync, and a redraw of the
 * canvas and its processor badges. Committing per keystroke made typing lag
 * on larger projects; batching also leaves one undo step per burst of typing
 * instead of one per character.
 *
 * `entity` names what is being edited (an item / section id, plus the field):
 * when it changes, whatever is pending goes to the entity it was typed for.
 * While nothing is pending, outside changes (undo, a collaborator) show up.
 */
export function useBufferedText(entity: string, value: string, commit: (v: string) => void, delay = 300) {
  const [local, setLocal] = useState(value)
  const latest = useRef(value)
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Updated after the cleanups below have run, so a flush on an entity change
  // still uses the commit of the entity the text was typed for.
  const commitRef = useRef(commit)

  const flush = useCallback(() => {
    clearTimeout(timer.current)
    if (!dirty.current) return
    dirty.current = false
    commitRef.current(latest.current)
  }, [])

  useLayoutEffect(() => () => flush(), [entity, flush])
  useLayoutEffect(() => { commitRef.current = commit })

  // Adopt the document's value when the entity changes, or when it changes
  // from outside while the box is not being typed in. While focused, our own
  // commits come back normalised (tags drop a trailing ", "), and taking
  // them would eat what is being typed; the box catches up on blur.
  const focused = useRef(false)
  const [blurs, setBlurs] = useState(0)
  const shownEntity = useRef(entity)
  useEffect(() => {
    const switched = shownEntity.current !== entity
    shownEntity.current = entity
    if (!switched && (dirty.current || focused.current)) return
    latest.current = value
    setLocal(value)
  }, [value, entity, blurs])

  const change = (v: string) => {
    latest.current = v
    dirty.current = true
    setLocal(v)
    clearTimeout(timer.current)
    timer.current = setTimeout(flush, delay)
  }
  const focus = () => { focused.current = true }
  const blur = () => { focused.current = false; flush(); setBlurs(n => n + 1) }
  return { value: local, change, flush, focus, blur }
}

type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>
type AreaProps = Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>

/** `<input>` whose text reaches the document through `onCommit` in batches (see useBufferedText). */
export function BufferedInput({ entity, value, onCommit, onBlur, onFocus, ...rest }: InputProps & { entity: string; value: string; onCommit: (v: string) => void }) {
  const b = useBufferedText(entity, value, onCommit)
  return <input {...rest} value={b.value} onChange={e => b.change(e.target.value)} onFocus={e => { b.focus(); onFocus?.(e) }} onBlur={e => { b.blur(); onBlur?.(e) }} />
}

/** `<textarea>` whose text reaches the document through `onCommit` in batches (see useBufferedText). */
export function BufferedTextarea({ entity, value, onCommit, onBlur, onFocus, ...rest }: AreaProps & { entity: string; value: string; onCommit: (v: string) => void }) {
  const b = useBufferedText(entity, value, onCommit)
  return <textarea {...rest} value={b.value} onChange={e => b.change(e.target.value)} onFocus={e => { b.focus(); onFocus?.(e) }} onBlur={e => { b.blur(); onBlur?.(e) }} />
}
