import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import type { Beat, Decision, DecisionJourney as Journey } from '../lib/types'
import ConfirmationTransition from './ConfirmationTransition'
import DecisionContext from './DecisionContext'
import DecisionInsight from './DecisionInsight'
import DecisionMoment from './DecisionMoment'
import DecisionQuestion from './DecisionQuestion'
import SlideToConfirm from './SlideToConfirm'
import '../styles/workspace.css'

interface Props {
  journey: Journey
  beat: Beat | null
  activeDecision: Decision | null
  transitionFinal: boolean | null
  progressDirection: 'up' | 'down'
  reduced: boolean
  onAnswer: (payload: { optionId?: string; free?: string }) => void
  onAdvance: () => void
  onConfirm: (decisionId: string) => void
  onTransitionDone: () => void
  onOpenJourney: () => void
  onAddDecision: () => void
  onLeave: () => void
}

const cardMotion = {
  initial: { opacity: 0, y: 16, filter: 'blur(8px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)' },
  exit: { opacity: 0, y: -14, filter: 'blur(8px)' },
  transition: { duration: 0.46, ease: [0.22, 1, 0.36, 1] as const },
}

export default function DecisionWorkspace({
  journey,
  beat,
  activeDecision,
  transitionFinal,
  progressDirection,
  reduced,
  onAnswer,
  onAdvance,
  onConfirm,
  onTransitionDone,
  onOpenJourney,
  onAddDecision,
  onLeave,
}: Props) {
  const isDecision = beat?.kind === 'decision' && !!activeDecision
  const inTransition = transitionFinal !== null

  /* Accessible fallback for the slide — revealed, not advertised. */
  const [showFallback, setShowFallback] = useState(false)
  useEffect(() => setShowFallback(false), [activeDecision?.id])

  /* Each card starts its own scroll at the top. */
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 })
  }, [beat?.id])

  const finalDecision =
    isDecision && !journey.decisions.some((d) => d.status !== 'confirmed' && d.id !== activeDecision!.id)

  return (
    <div className="screen ws">
      <header className="ws__bar">
        <button type="button" className="ws__icon" onClick={onLeave} aria-label="Leave this decision">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
            <path
              d="M14.5 6 8.5 12l6 6"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        <button type="button" className="ws__title" onClick={onOpenJourney}>
          <span className="ws__title-text">{journey.title}</span>
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden>
            <path
              d="M8 10.5 12 14.5l4-4"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        <button type="button" className="ws__icon" onClick={onAddDecision} aria-label="Add a decision">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
            <path
              d="M12 6.5v11M6.5 12h11"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </header>

      {/* Journey maturity. Deliberately unlabelled — it is a sense, not a number. */}
      <div className="ws__progress" role="presentation">
        <motion.span
          className={`ws__progress-fill ${progressDirection === 'down' ? 'is-down' : ''}`}
          animate={{ scaleX: Math.max(0.02, journey.internal_progress) }}
          transition={
            progressDirection === 'down'
              ? { duration: 1.05, ease: [0.65, 0, 0.35, 1] }
              : { type: 'spring', stiffness: 90, damping: 22 }
          }
        />
      </div>

      <div className="screen__body ws__body" ref={bodyRef}>
        <AnimatePresence mode="wait" initial={false}>
          {beat && (
            <motion.div key={beat.id} className="ws__card" {...cardMotion}>
              {beat.kind === 'context' && <DecisionContext beat={beat} />}
              {beat.kind === 'insight' && <DecisionInsight beat={beat} />}
              {beat.kind === 'question' && <DecisionQuestion beat={beat} onAnswer={onAnswer} />}
              {beat.kind === 'decision' && activeDecision && (
                <DecisionMoment decision={activeDecision} />
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="screen__dock ws__dock">
        <AnimatePresence mode="wait" initial={false}>
          {isDecision ? (
            <motion.div
              key="slide"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
            >
              <SlideToConfirm
                resetKey={activeDecision!.id}
                tone={finalDecision ? 'final' : 'default'}
                onConfirm={() => onConfirm(activeDecision!.id)}
                disabled={inTransition}
              />
              <div className="subtle-row">
                {showFallback ? (
                  <button
                    type="button"
                    className="subtle-action is-fallback"
                    onClick={() => onConfirm(activeDecision!.id)}
                  >
                    Confirm this decision
                  </button>
                ) : (
                  <button
                    type="button"
                    className="subtle-action"
                    onClick={() => setShowFallback(true)}
                  >
                    Can’t slide?
                  </button>
                )}
              </div>
            </motion.div>
          ) : beat && beat.kind !== 'question' ? (
            <motion.div
              key="continue"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
            >
              <button type="button" className="btn btn--ghost" onClick={onAdvance}>
                Continue
              </button>
            </motion.div>
          ) : (
            <motion.div key="none" className="ws__dock-spacer" />
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {inTransition && (
          <ConfirmationTransition
            key="confirm-overlay"
            final={transitionFinal!}
            onDone={onTransitionDone}
            reduced={reduced}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
