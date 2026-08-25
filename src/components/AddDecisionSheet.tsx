import { useLayoutEffect, useRef, useState } from 'react'
import Sheet from './Sheet'

interface Props {
  open: boolean
  onClose: () => void
  onAdd: (text: string) => void
}

/**
 * §29 — the user can name a decision at any point, and it takes priority over
 * anything the system assumed about what was left.
 */
export default function AddDecisionSheet({ open, onClose, onAdd }: Props) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }, [text, open])

  useLayoutEffect(() => {
    if (!open) setText('')
  }, [open])

  const submit = () => {
    const value = text.trim()
    if (!value) return
    ref.current?.blur()
    onAdd(value)
    setText('')
  }

  return (
    <Sheet open={open} title="Add a decision" onClose={onClose}>
      <p className="sheet__lead">
        Something you need to decide that hasn’t come up. It goes next.
      </p>
      <div className="add__field">
        <textarea
          ref={ref}
          className="add__input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="Should I…"
          rows={2}
          autoFocus
          enterKeyHint="done"
          aria-label="Your decision"
        />
        <span className="add__rule" aria-hidden />
      </div>
      <button type="button" className="btn btn--primary" onClick={submit} disabled={!text.trim()}>
        Add it
      </button>
    </Sheet>
  )
}
