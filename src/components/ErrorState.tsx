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
  // Faults that a live probe can actually explain — offer it rather than
  // making someone remember a URL while looking at an error.
  const probeable = [
    'unconfigured', 'auth', 'quota', 'rate_limited',
    'model_unavailable', 'model_request_rejected', 'upstream',
  ].includes(error.code)

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

          {/* Where it broke, in one line. Carries no key and no journey
              content — only status codes and error classes — so it is safe to
              leave on: these faults only ever appear in a real deployment,
              which is exactly where they are hardest to diagnose blind. */}
          {probeable && (
            <p className="state-screen__probe">
              <a href="/api/health?probe=1" target="_blank" rel="noreferrer">
                Run the deployment diagnostic
              </a>
            </p>
          )}

          {error.diagnostic && (
            <details className="diag">
              <summary className="diag__summary">Details</summary>
              <p className="diag__body">
                <code>{error.code}</code>
                <span>{error.diagnostic}</span>
              </p>
            </details>
          )}
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
