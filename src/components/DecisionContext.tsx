import { motion } from 'framer-motion'

interface Props {
  framing: string | null
  /** A tension LOCK has found between what the user wants and what they said. */
  contradiction?: string | null
}

/**
 * LOCK's voice above a question or a decision.
 *
 * There is deliberately no screen whose only content is this. If LOCK has
 * nothing to add that the user did not already say, the server sends null and
 * nothing renders — silence is the normal state.
 *
 * A contradiction is the one time LOCK pushes back, so it is marked differently
 * from ordinary framing and appears only on the turn it is found.
 */
export default function DecisionContext({ framing, contradiction = null }: Props) {
  if (!framing && !contradiction) return null
  return (
    <div className="framings">
      {contradiction && (
        <motion.p
          className="framing framing--tension"
          initial={{ opacity: 0, y: 8, filter: 'blur(5px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        >
          <span className="framing__rule" aria-hidden />
          <span>
            <span className="framing__label">Worth saying</span>
            {contradiction}
          </span>
        </motion.p>
      )}

      {framing && (
        <motion.p
          className="framing"
          initial={{ opacity: 0, y: 8, filter: 'blur(5px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          transition={{ duration: 0.5, delay: contradiction ? 0.12 : 0, ease: [0.22, 1, 0.36, 1] }}
        >
          <span className="framing__rule" aria-hidden />
          <span>{framing}</span>
        </motion.p>
      )}
    </div>
  )
}
