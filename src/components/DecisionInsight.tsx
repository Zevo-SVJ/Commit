import { motion } from 'framer-motion'
import type { InsightBeat } from '../lib/types'

/** A single observation. Never more than one at a time. */
export default function DecisionInsight({ beat }: { beat: InsightBeat }) {
  const shift = beat.tone === 'shift'
  return (
    <div className={`card card--insight ${shift ? 'is-shift' : ''}`}>
      <p className="t-eyebrow">{beat.label}</p>
      <motion.blockquote
        className="insight"
        initial={{ opacity: 0, y: 12, filter: 'blur(6px)' }}
        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
        transition={{ duration: 0.6, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
      >
        <span className="insight__rule" aria-hidden />
        <p className="insight__body">{beat.body}</p>
      </motion.blockquote>
    </div>
  )
}
