import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import type { Decision, DecisionJourney, Step } from '../../shared/types.ts'
import type { Phase } from '../lib/useJourney.ts'
import ConfirmationAnimation from './ConfirmationAnimation'
import DecisionMoment from './DecisionMoment'
import DecisionQuestion from './DecisionQuestion'
import JourneyTransition from './JourneyTransition'
import LoadingState from './LoadingState'
import SlideToConfirm from './SlideToConfirm'
import '../styles/workspace.css'

interface Props {
  journey: DecisionJourney
  step: Step | null
  phase: Phase
  settling: boolean
  pendingDecision: Decision | null
  reduced: boolean
  loadingLabel: string
  onAnswer: (text: string) => void
  onConfirm: (decisionId: string) => void
  onConfirmationDone: () => void
  onOpenJourney: () => void
  onAddDecision: () => void
  onLeave: () => void
}

export default function DecisionWorkspace({
  journey,
  step,
  phase,
  settling,
  pendingDecision,
  reduced,
  loadingLabel,
  onAnswer,
  onConfirm,
  onConfirmationDone,
  onOpenJourney,
  onAddDecision,
  onLeave,
}: Props) {
  const thinking = phase === 'thinking'
  const confirming = phase === 'confirming'
  const showSlide = !!pendingDecision && !thinking

  /* The accessible path, revealed rather than advertised. */
  const [showFallback, setShowFallback] = useState(false)
  useEffect(() => setShowFallback(false), [pendingDecision?.id])

  /* Each step starts its own scroll at the top. */
  const bodyRef = useRef<HTMLDivElement>(null)
  const stepKey = thinking ? 'thinking' : stepIdOf(step)
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 })
  }, [stepKey])

  const confirmedCount = journey.decisions.filter((d) => d.status === 'confirmed').length

  return (
    <div className="screen ws">
      <header className="ws__bar">
        <button type="button" className="ws__icon" onClick={onLeave} aria-label="Leave this decision">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
            <path d="M14.5 6 8.5 12l6 6" stroke="currentColor" strokeWidth="1.9"
              strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        <button type="button" className="ws__title" onClick={onOpenJourney}>
          <span className="ws__title-text">{journey.title}</span>
          {/* LOCK does not know how many decisions a journey will hold, so this
              counts what has been settled rather than faking a total. Hidden
              until there is actually something to show. */}
          {confirmedCount > 0 && (
            <span
              className="ws__marks"
              aria-label={`${confirmedCount} decided so far`}
            >
              {Array.from({ length: confirmedCount }).map((_, i) => (
                <span key={i} className="ws__mark is-done" />
              ))}
              {pendingDecision && <span className="ws__mark" />}
            </span>
          )}
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden>
            <path d="M8 10.5 12 14.5l4-4" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        <button type="button" className="ws__icon" onClick={onAddDecision} aria-label="Add a decision">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
            <path d="M12 6.5v11M6.5 12h11" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      {/* Journey maturity. Unlabelled on purpose: a sense, not a number. */}
      <div className="ws__progress" role="presentation">
        <motion.span
          className="ws__progress-fill"
          animate={{ scaleX: Math.max(0.02, journey.progress) }}
          transition={{ type: 'spring', stiffness: 90, damping: 22 }}
        />
      </div>

      <div className="screen__body ws__body" ref={bodyRef}>
        <JourneyTransition stepKey={stepKey}>
          {thinking ? (
            <LoadingState label={loadingLabel} reduced={reduced} />
          ) : step?.kind === 'question' ? (
            <DecisionQuestion step={step} onAnswer={onAnswer} />
          ) : step?.kind === 'decision' ? (
            <DecisionMoment
              decision={step.decision}
              framing={step.framing}
              contradiction={step.contradiction}
            />
          ) : null}
        </JourneyTransition>
      </div>

      <div className="screen__dock ws__dock">
        <AnimatePresence mode="wait" initial={false}>
          {showSlide ? (
            <motion.div
              key="slide"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
            >
              <SlideToConfirm
                resetKey={pendingDecision!.id}
                tone={pendingDecision!.isFinal ? 'final' : 'default'}
                reduced={reduced}
                onConfirm={() => onConfirm(pendingDecision!.id)}
                disabled={confirming}
              />
              <div className="subtle-row">
                {showFallback ? (
                  <button
                    type="button"
                    className="subtle-action is-fallback"
                    onClick={() => onConfirm(pendingDecision!.id)}
                  >
                    Confirm this decision
                  </button>
                ) : (
                  <button type="button" className="subtle-action" onClick={() => setShowFallback(true)}>
                    Can’t slide?
                  </button>
                )}
              </div>
            </motion.div>
          ) : (
            <motion.div key="none" className="ws__dock-spacer" />
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {confirming && (
          <ConfirmationAnimation
            key="confirm"
            final={!!pendingDecision?.isFinal || journey.status === 'complete'}
            settling={settling}
            onDone={onConfirmationDone}
            reduced={reduced}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

function stepIdOf(step: Step | null): string {
  if (!step) return 'empty'
  if (step.kind === 'question') return step.id
  if (step.kind === 'decision') return step.decision.id
  return 'complete'
}
