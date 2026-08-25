import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import '../styles/transition.css'

interface Props {
  /** True when this decision resolved the whole journey. */
  final: boolean
  onDone: () => void
  reduced?: boolean
}

/**
 * The pause after committing. Two short lines, then the next thing.
 * No modal, no celebration — the feeling should just be "done".
 */
export default function ConfirmationTransition({ final, onDone, reduced = false }: Props) {
  const [phase, setPhase] = useState<0 | 1 | 2>(0)

  const t = reduced
    ? { second: 140, out: 420 }
    : { second: 950, out: 1900 }

  useEffect(() => {
    const a = window.setTimeout(() => setPhase(1), t.second)
    const b = window.setTimeout(() => setPhase(2), t.out)
    const c = window.setTimeout(onDone, t.out + (reduced ? 100 : 340))
    return () => {
      window.clearTimeout(a)
      window.clearTimeout(b)
      window.clearTimeout(c)
    }
  }, [onDone, t.second, t.out, reduced])

  const second = final ? 'This is decided.' : 'Moving forward.'

  return (
    <motion.div
      className={`confirmed ${final ? 'is-final' : ''}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: phase === 2 ? 0 : 1 }}
      transition={{ duration: reduced ? 0.1 : phase === 2 ? 0.4 : 0.3, ease: [0.22, 1, 0.36, 1] }}
      role="status"
      aria-live="polite"
    >
      <div className="confirmed__inner">
        <motion.div
          className="confirmed__mark"
          initial={{ scale: 0.7, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 340, damping: 26, delay: reduced ? 0 : 0.06 }}
        >
          <svg viewBox="0 0 44 44" width="44" height="44" fill="none" aria-hidden>
            <circle
              cx="22"
              cy="22"
              r="20"
              stroke="currentColor"
              strokeOpacity="0.22"
              strokeWidth="1.5"
            />
            <motion.path
              d="M13.5 22.6 19.4 28.4 30.8 16.4"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: reduced ? 0.01 : 0.44, delay: reduced ? 0 : 0.16, ease: [0.22, 1, 0.36, 1] }}
            />
          </svg>
        </motion.div>

        <div className="confirmed__lines">
          <AnimatePresence mode="wait" initial={false}>
            <motion.p
              key={phase >= 1 ? 'second' : 'first'}
              className="confirmed__line"
              initial={{ opacity: 0, y: 8, filter: 'blur(6px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -8, filter: 'blur(6px)' }}
              transition={{ duration: reduced ? 0.1 : 0.42, ease: [0.22, 1, 0.36, 1] }}
            >
              {phase >= 1 ? second : 'Decision confirmed.'}
            </motion.p>
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  )
}
