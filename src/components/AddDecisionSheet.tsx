import { useLayoutEffect, useState } from 'react'
import DecisionInput from './DecisionInput'
import Sheet from './Sheet'

interface Props {
  open: boolean
  onClose: () => void
  onAdd: (text: string) => void
}

/**
 * A decision the user raises themselves. It goes next, ahead of whatever LOCK
 * was planning — their concern outranks the sequence.
 */
export default function AddDecisionSheet({ open, onClose, onAdd }: Props) {
  const [text, setText] = useState('')

  useLayoutEffect(() => {
    if (!open) setText('')
  }, [open])

  const submit = () => {
    const value = text.trim()
    if (!value) return
    onAdd(value)
    setText('')
  }

  return (
    <Sheet open={open} title="Add a decision" onClose={onClose}>
      <p className="sheet__lead">Something you need to decide that hasn’t come up.</p>
      <DecisionInput
        value={text}
        onChange={setText}
        onSubmit={submit}
        placeholder="Should I…"
        label="Your decision"
        autoFocus
        maxHeight={140}
      />
      <button
        type="button"
        className="btn btn--primary add__submit"
        onClick={submit}
        disabled={!text.trim()}
      >
        Add it
      </button>
    </Sheet>
  )
}
