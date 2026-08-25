import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { EntryMode } from '../lib/engine'
import DemoSelector from './DemoSelector'
import '../styles/home.css'

const COPY: Record<EntryMode, { heading: string; placeholder: string; hint: string }> = {
  decision: {
    heading: 'What are you deciding?',
    placeholder: 'Say it plainly.',
    hint: 'Not sure yet? Tell me what’s going on.',
  },
  situation: {
    heading: 'What’s going on?',
    placeholder: 'Start anywhere. I’ll find the decision in it.',
    hint: 'Actually, I know what I’m deciding.',
  },
}

interface Props {
  onStart: (input: string, mode: EntryMode) => void
  onDemo: (demo: 'simple' | 'complex') => void
}

export default function DecisionHome({ onStart, onDemo }: Props) {
  const [mode, setMode] = useState<EntryMode>('decision')
  const [value, setValue] = useState('')
  const areaRef = useRef<HTMLTextAreaElement>(null)

  const copy = COPY[mode]
  const ready = value.trim().length > 1

  /* Auto-grow, capped so the field never pushes the action off screen. */
  useLayoutEffect(() => {
    const el = areaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 190)}px`
  }, [value, mode])

  /* Keep the caret in view when the keyboard animates in. */
  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    const onFocus = () => {
      window.setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 260)
    }
    el.addEventListener('focus', onFocus)
    return () => el.removeEventListener('focus', onFocus)
  }, [])

  const submit = () => {
    if (!ready) return
    areaRef.current?.blur()
    onStart(value.trim(), mode)
  }

  const swapMode = () => {
    setMode((m) => (m === 'decision' ? 'situation' : 'decision'))
    areaRef.current?.focus()
  }

  return (
    <div className="screen home">
      <header className="home__mark">
        <span>Commit</span>
      </header>

      <div className="screen__body home__body">
        <div className="home__center">
          <AnimatePresence mode="wait" initial={false}>
            <motion.h1
              key={mode}
              className="t-display home__heading"
              initial={{ opacity: 0, y: 8, filter: 'blur(6px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -6, filter: 'blur(6px)' }}
              transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
            >
              {copy.heading}
            </motion.h1>
          </AnimatePresence>

          <div className={`home__field ${value ? 'is-filled' : ''}`}>
            <textarea
              ref={areaRef}
              className="home__input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submit()
                }
              }}
              placeholder={copy.placeholder}
              rows={1}
              autoComplete="off"
              autoCorrect="on"
              spellCheck
              enterKeyHint="go"
              aria-label={copy.heading}
            />
            <span className="home__rule" aria-hidden />
          </div>

          <button type="button" className="home__swap" onClick={swapMode}>
            {copy.hint}
          </button>
        </div>
      </div>

      <div className="screen__dock home__dock">
        <button
          type="button"
          className="btn btn--primary"
          onClick={submit}
          disabled={!ready}
        >
          {mode === 'decision' ? 'Begin' : 'Find the decision'}
        </button>
        <DemoSelector onDemo={onDemo} />
      </div>
    </div>
  )
}
