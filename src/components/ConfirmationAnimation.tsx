import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { CONFIRM, CONFIRM_REDUCED } from '../lib/timing'
import '../styles/confirmation.css'

interface Props {
  /** True when this decision resolved the whole journey. */
  final: boolean
  /** The turn has not landed yet; hold the confirmed state instead of leaving. */
  settling: boolean
  onDone: () => void
  reduced?: boolean
}

type Phase = 'draw' | 'settle' | 'message' | 'exit'

/**
 * Phases 3–6 of the confirmation. Phases 1 and 2 — the hold and the resolve —
 * belong to the slider, so the sequence reads as one continuous response to
 * the gesture rather than a screen that replaced it.
 *
 * The feeling to hit is a system-level confirmation: precise, quiet, over.
 * No celebration, no colour flood, nothing that needs to be dismissed.
 */
export default function ConfirmationAnimation({
  final,
  settling,
  onDone,
  reduced = false,
}: Props) {
  const t = reduced ? CONFIRM_REDUCED : CONFIRM
  const [phase, setPhase] = useState<Phase>('draw')

  useEffect(() => {
    const timers = [
      window.setTimeout(() => setPhase('settle'), t.draw),
      window.setTimeout(() => setPhase('message'), t.draw + t.settle),
    ]
    return () => timers.forEach(window.clearTimeout)
  }, [t.draw, t.settle])

  // The message is held for its full duration, then the sequence ends — unless
  // the next step has not arrived, in which case it waits here rather than
  // dropping the user onto a spinner.
  useEffect(() => {
    if (phase !== 'message') return
    const timer = window.setTimeout(() => {
      setPhase('exit')
      onDone()
    }, t.message)
    return () => window.clearTimeout(timer)
  }, [phase, t.message, onDone])

  const showMessage = phase === 'message' || phase === 'exit'

  return (
    <motion.div
      className={`confirm ${final ? 'is-final' : ''}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: phase === 'exit' && !settling ? 0 : 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: (phase === 'exit' ? t.exit : t.resolve) / 1000, ease: [0.22, 1, 0.36, 1] }}
      role="status"
      aria-live="polite"
    >
      <div className="confirm__inner">
        <motion.div
          className="confirm__mark"
          initial={{ scale: 0.86, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 380, damping: 28 }}
        >
          {/* Phase 4 — one ring expands outward and dissolves. The only
              flourish in the whole sequence. */}
          {!reduced && (
            <motion.span
              className="confirm__ring"
              aria-hidden
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1.55, opacity: [0, 0.5, 0] }}
              transition={{ duration: (t.draw + t.settle) / 1000, ease: 'easeOut', delay: t.draw / 2000 }}
            />
          )}

          <svg viewBox="0 0 56 56" width="56" height="56" fill="none" aria-hidden>
            <circle
              cx="28"
              cy="28"
              r="26"
              stroke="currentColor"
              strokeOpacity="0.18"
              strokeWidth="1.5"
            />
            {/* Phase 3 — drawn, not faded in. */}
            <motion.path
              d="M17 28.8 L24.6 36.2 L39 20.6"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 1 }}
              transition={{
                pathLength: { duration: t.draw / 1000, ease: [0.32, 0.9, 0.35, 1] },
                opacity: { duration: 0.08 },
              }}
            />
          </svg>
        </motion.div>

        <div className="confirm__lines">
          <motion.p
            className="confirm__line"
            initial={{ opacity: 0, y: 6 }}
            animate={showMessage ? { opacity: 1, y: 0 } : { opacity: 0, y: 6 }}
            /* Arrives quickly so the line spends its time being readable
               rather than fading in. The hold above is sized against this. */
            transition={{ duration: t.messageFade / 1000, ease: [0.22, 1, 0.36, 1] }}
          >
            {final ? 'Decision complete.' : 'Decision confirmed.'}
          </motion.p>

          {/* Only appears if the next step is genuinely still in flight. */}
          <motion.p
            className="confirm__waiting"
            initial={{ opacity: 0 }}
            animate={{ opacity: settling && showMessage ? 1 : 0 }}
            transition={{ duration: 0.4, delay: settling ? 0.25 : 0 }}
            aria-hidden={!settling}
          >
            Working out what is left
          </motion.p>
        </div>
      </div>
    </motion.div>
  )
}
