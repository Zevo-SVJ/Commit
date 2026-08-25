import { AnimatePresence, motion } from 'framer-motion'
import { useState } from 'react'
import DecisionInput from './DecisionInput'
import '../styles/home.css'

/**
 * Two situations that show what LOCK takes: one stated plainly, one with the
 * detail already in it. They fill the field so the user can edit before
 * sending — nothing here is scripted, both run through the same reasoning as
 * anything else typed by hand.
 */
const EXAMPLES = [
  { label: 'Short', text: 'Should I get a cat?' },
  {
    label: 'Detailed',
    text:
      'A studio has offered me €120,000 for a nine-month build, but they want exclusivity in their category for eighteen months — nine of them after delivery. Another client in the same category has been circling for weeks. About half of next year is already committed.',
  },
]

interface Props {
  onStart: (input: string) => void
}

export default function LockHome({ onStart }: Props) {
  const [value, setValue] = useState('')
  const [unsure, setUnsure] = useState(false)
  const ready = value.trim().length > 1

  const submit = () => {
    if (ready) onStart(value.trim())
  }

  return (
    <div className="screen home">
      <header className="home__mark">
        <span>LOCK</span>
      </header>

      <div className="screen__body home__body">
        <div className="home__center">
          <AnimatePresence mode="wait" initial={false}>
            <motion.h1
              key={unsure ? 'unsure' : 'known'}
              className="t-display home__heading"
              initial={{ opacity: 0, y: 8, filter: 'blur(6px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -6, filter: 'blur(6px)' }}
              transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
            >
              {unsure ? 'What’s going on?' : 'What are you deciding?'}
            </motion.h1>
          </AnimatePresence>

          <DecisionInput
            value={value}
            onChange={setValue}
            onSubmit={submit}
            placeholder={unsure ? 'Start anywhere.' : 'Say it plainly.'}
            label={unsure ? 'Describe the situation' : 'What are you deciding?'}
          />

          <button type="button" className="home__swap" onClick={() => setUnsure((u) => !u)}>
            {unsure ? 'Actually, I know what I’m deciding.' : 'Not sure yet? Describe the situation.'}
          </button>
        </div>
      </div>

      <div className="screen__dock home__dock">
        <button type="button" className="btn btn--primary" onClick={submit} disabled={!ready}>
          Begin
        </button>

        <div className="examples">
          <span className="examples__label">Or start from</span>
          <div className="examples__row">
            {EXAMPLES.map((ex, i) => (
              <span key={ex.label} className="examples__item">
                {i > 0 && <span className="examples__sep" aria-hidden />}
                <button
                  type="button"
                  className="examples__chip"
                  onClick={() => setValue(ex.text)}
                >
                  {ex.label}
                </button>
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
