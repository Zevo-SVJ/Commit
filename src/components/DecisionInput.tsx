import { useEffect, useLayoutEffect, useRef } from 'react'

interface Props {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  placeholder: string
  label: string
  autoFocus?: boolean
  /** Caps growth so the field never pushes the action out of the viewport. */
  maxHeight?: number
}

/**
 * The editorial field. One hairline, no box, no chrome — the user is stating
 * something, not filling in a form or prompting a model.
 */
export default function DecisionInput({
  value,
  onChange,
  onSubmit,
  placeholder,
  label,
  autoFocus = false,
  maxHeight = 190,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
  }, [value, maxHeight])

  // Keep the caret in view once the keyboard has finished animating in.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onFocus = () => {
      window.setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 260)
    }
    el.addEventListener('focus', onFocus)
    return () => el.removeEventListener('focus', onFocus)
  }, [])

  return (
    <div className={`field ${value ? 'is-filled' : ''}`}>
      <textarea
        ref={ref}
        className="field__input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Enter submits; Shift+Enter is a newline. On phones the key reads
          // "go", so the same gesture works without a modifier.
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            ref.current?.blur()
            onSubmit()
          }
        }}
        placeholder={placeholder}
        rows={1}
        autoFocus={autoFocus}
        autoComplete="off"
        autoCorrect="on"
        spellCheck
        enterKeyHint="go"
        aria-label={label}
      />
      <span className="field__rule" aria-hidden />
    </div>
  )
}
