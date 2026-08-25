import { AnimatePresence, motion } from 'framer-motion'
import { useLayoutEffect, useRef, useState } from 'react'
import type { QuestionStep } from '../../shared/types.ts'
import DecisionContext from './DecisionContext'

const list = { hidden: {}, show: { transition: { staggerChildren: 0.06, delayChildren: 0.18 } } }
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.44, ease: [0.22, 1, 0.36, 1] } },
}

interface Props {
  step: QuestionStep
  onAnswer: (text: string) => void
}

/** One question. Lock only reaches this screen when the answer would change something. */
export default function DecisionQuestion({ step, onAnswer }: Props) {
  const [writing, setWriting] = useState(step.options.length === 0)
  const [text, setText] = useState('')
  const [chosen, setChosen] = useState<string | null>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = areaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`
  }, [text, writing])

  const pick = (option: string) => {
    if (chosen) return
    setChosen(option)
    // Let the selection register before the card leaves.
    window.setTimeout(() => onAnswer(option), 190)
  }

  const send = () => {
    const value = text.trim()
    if (!value) return
    areaRef.current?.blur()
    onAnswer(value)
  }

  return (
    <div className="card">
      <DecisionContext framing={step.framing} contradiction={step.contradiction} />
      <h2 className="t-display card__prompt">{step.prompt}</h2>

      <AnimatePresence mode="wait" initial={false}>
        {!writing ? (
          <motion.ul
            key="options"
            className="options"
            variants={list}
            initial="hidden"
            animate="show"
            exit={{ opacity: 0, transition: { duration: 0.18 } }}
          >
            {step.options.map((option) => (
              <motion.li key={option} variants={item}>
                <button
                  type="button"
                  className={`option ${chosen === option ? 'is-chosen' : ''} ${
                    chosen && chosen !== option ? 'is-dimmed' : ''
                  }`}
                  onClick={() => pick(option)}
                  disabled={!!chosen}
                >
                  <span className="option__label">{option}</span>
                  <span className="option__mark" aria-hidden />
                </button>
              </motion.li>
            ))}
          </motion.ul>
        ) : (
          <motion.div
            key="write"
            className="write"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.16 } }}
            transition={{ duration: 0.36, ease: [0.22, 1, 0.36, 1] }}
          >
            <textarea
              ref={areaRef}
              className="write__input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
              placeholder="In your own words…"
              rows={2}
              autoFocus={step.options.length > 0}
              enterKeyHint="send"
              aria-label={step.prompt}
            />
            <div className="write__actions">
              {step.options.length > 0 ? (
                <button type="button" className="btn btn--bare" onClick={() => setWriting(false)}>
                  Back
                </button>
              ) : (
                <span />
              )}
              <button
                type="button"
                className="write__send"
                onClick={send}
                disabled={!text.trim()}
                aria-label="Send answer"
              >
                <svg viewBox="0 0 24 24" fill="none" width="19" height="19">
                  <path
                    d="M5 12h13M12.5 6l6 6-6 6"
                    stroke="currentColor"
                    strokeWidth="2.1"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {step.allowFree && !writing && !chosen && (
        <button type="button" className="subtle-action card__aside" onClick={() => setWriting(true)}>
          None of these — let me say it
        </button>
      )}
    </div>
  )
}
