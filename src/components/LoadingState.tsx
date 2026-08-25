import { motion } from 'framer-motion'
import '../styles/states.css'

interface Props {
  label: string
  reduced?: boolean
}

/**
 * A real wait, named plainly. It does not say "AI is thinking" — the user did
 * not come here to be told there is a model, and Lock is supposed to be quiet
 * about itself.
 */
export default function LoadingState({ label, reduced = false }: Props) {
  return (
    <div className="state" role="status" aria-live="polite">
      <motion.span
        className="state__pulse"
        aria-hidden
        animate={reduced ? {} : { scale: [1, 1.3, 1], opacity: [0.45, 0.95, 0.45] }}
        transition={{ duration: 2, repeat: Infinity, ease: [0.65, 0, 0.35, 1] }}
      />
      <motion.p
        className="state__label"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
      >
        {label}
      </motion.p>
    </div>
  )
}
