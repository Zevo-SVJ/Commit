import { motion } from 'framer-motion'
import type { ContextBeat } from '../lib/types'

const list = {
  hidden: {},
  show: { transition: { staggerChildren: 0.075, delayChildren: 0.16 } },
}
const item = {
  hidden: { opacity: 0, y: 10, filter: 'blur(5px)' },
  show: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] } },
}

/** What the system understood. Stated once, then got out of the way. */
export default function DecisionContext({ beat }: { beat: ContextBeat }) {
  return (
    <div className="card card--context">
      <p className="t-eyebrow">{beat.label}</p>
      <h2 className="t-title card__lead">{beat.lead}</h2>

      <motion.ul className="facts" variants={list} initial="hidden" animate="show">
        {beat.facts.map((fact) => (
          <motion.li key={fact} className="facts__item" variants={item}>
            <span className="facts__dot" aria-hidden />
            <span className="facts__text">{fact}</span>
          </motion.li>
        ))}
      </motion.ul>
    </div>
  )
}
