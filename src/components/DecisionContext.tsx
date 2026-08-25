import { motion } from 'framer-motion'

/**
 * LOCK's single line of framing, above a question or a decision.
 *
 * There is deliberately no screen whose only content is this. If LOCK has
 * nothing to add that the user did not already say, the server sends null and
 * nothing renders — silence is the normal state.
 */
export default function DecisionContext({ framing }: { framing: string | null }) {
  if (!framing) return null
  return (
    <motion.p
      className="framing"
      initial={{ opacity: 0, y: 8, filter: 'blur(5px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
    >
      <span className="framing__rule" aria-hidden />
      <span>{framing}</span>
    </motion.p>
  )
}
