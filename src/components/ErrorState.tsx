import { motion } from 'framer-motion'
import type { LockError } from '../lib/api.ts'
import '../styles/states.css'

interface Props {
  error: LockError
  onRetry: () => void
  onLeave: () => void
}

/**
 * Calm recovery. The journey behind this is untouched — retrying replays the
 * turn that failed, it does not start over.
 */
export default function ErrorState({ error, onRetry, onLeave }: Props) {
  const unconfigured = error.code === 'unconfigured'

  return (
    <div className="screen state-screen">
      <div className="screen__body state-screen__body">
        <motion.div
          className="state-screen__inner"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.44, ease: [0.22, 1, 0.36, 1] }}
        >
          <span className="state__dot" aria-hidden />
          <h2 className="t-title state-screen__title">{error.message}</h2>
          <p className="t-quiet state-screen__body-text">
            {unconfigured
              ? 'No model is connected to this deployment yet. Nothing you have entered has been lost.'
              : 'Your journey is still here. Nothing was lost.'}
          </p>
        </motion.div>
      </div>

      <div className="screen__dock">
        {error.retryable && (
          <button type="button" className="btn btn--primary" onClick={onRetry}>
            Try again
          </button>
        )}
        <div className="subtle-row">
          <button type="button" className="subtle-action" onClick={onLeave}>
            Start something else
          </button>
        </div>
      </div>
    </div>
  )
}
