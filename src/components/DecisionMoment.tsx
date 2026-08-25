import { motion } from 'framer-motion'
import type { Decision } from '../lib/types'

/**
 * The moment of focus. Everything else on screen is subordinate to this,
 * because the next thing the user does is commit to it.
 */
export default function DecisionMoment({ decision }: { decision: Decision }) {
  return (
    <div className="card card--moment">
      <motion.div
        initial={{ opacity: 0, y: 14, filter: 'blur(8px)' }}
        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
        transition={{ duration: 0.62, ease: [0.22, 1, 0.36, 1] }}
      >
        <p className="t-eyebrow moment__eyebrow">
          Your decision
          {decision.source === 'user' && <span className="moment__tag">Yours</span>}
        </p>

        <h2 className="t-display moment__answer">{decision.answer}</h2>
      </motion.div>

      <motion.div
        className="moment__foot"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.22, ease: [0.22, 1, 0.36, 1] }}
      >
        <span className="moment__rule" aria-hidden />
        <p className="t-quiet moment__rationale">{decision.rationale}</p>
      </motion.div>
    </div>
  )
}
