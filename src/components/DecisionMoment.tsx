import { motion } from 'framer-motion'
import type { Decision } from '../../shared/types.ts'
import DecisionContext from './DecisionContext'

/**
 * The moment of focus. The commitment is the largest thing on the screen,
 * because committing to it is the next thing that happens.
 */
export default function DecisionMoment({
  decision,
  framing,
}: {
  decision: Decision
  framing: string | null
}) {
  return (
    <div className="card card--moment">
      <DecisionContext framing={framing} />

      <motion.div
        initial={{ opacity: 0, y: 14, filter: 'blur(8px)' }}
        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
        transition={{ duration: 0.58, ease: [0.22, 1, 0.36, 1] }}
      >
        <p className="t-eyebrow moment__eyebrow">
          Your decision
          {decision.source === 'user' && <span className="moment__tag">Yours</span>}
        </p>
        <h2 className="t-display moment__answer">{decision.commitment}</h2>
      </motion.div>

      {decision.rationale && (
        <motion.div
          className="moment__foot"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
        >
          {/* No rule here: the accent rule belongs to LOCK's framing alone, so
              the two lines around the decision do not read as the same thing. */}
          <p className="t-quiet moment__rationale">{decision.rationale}</p>
        </motion.div>
      )}
    </div>
  )
}
