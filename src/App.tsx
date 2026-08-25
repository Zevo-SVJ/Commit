import { AnimatePresence, MotionConfig, motion } from 'framer-motion'
import { useCallback, useEffect, useState } from 'react'
import AddDecisionSheet from './components/AddDecisionSheet'
import DecisionJourneySheet from './components/DecisionJourney'
import DecisionWorkspace from './components/DecisionWorkspace'
import ErrorState from './components/ErrorState'
import JourneyComplete from './components/JourneyComplete'
import LoadingState from './components/LoadingState'
import LockHome from './components/LockHome'
import { useAppViewport, usePrefersReducedMotion } from './lib/useAppViewport'
import { useJourney } from './lib/useJourney'

const screenMotion = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] as const },
}

/** What Lock is doing, said plainly. Never "AI is thinking". */
function loadingLabel(hasJourney: boolean, decided: number): string {
  if (!hasJourney) return 'Understanding'
  if (decided > 0) return 'Finding what’s left'
  return 'Looking at what matters'
}

export default function App() {
  useAppViewport()
  const reduced = usePrefersReducedMotion()

  const {
    state,
    pendingDecision,
    confirmedDecisions,
    start,
    answer,
    addDecision,
    confirm,
    confirmationDone,
    retry,
    reset,
  } = useJourney()

  const [journeyOpen, setJourneyOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)

  const { journey, step, phase, error } = state
  // The confirmation owns the screen until it has finished playing, even once
  // the turn that completes the journey has already landed.
  const complete =
    journey?.status === 'complete' && step?.kind === 'complete' && phase !== 'confirming'

  /* Browser back leaves the journey rather than the site. */
  useEffect(() => {
    if (phase === 'home') return
    window.history.pushState({ lock: true }, '')
    const onPop = () => {
      if (addOpen || journeyOpen) {
        setAddOpen(false)
        setJourneyOpen(false)
        window.history.pushState({ lock: true }, '')
        return
      }
      reset()
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [phase, reset, addOpen, journeyOpen])

  const leave = useCallback(() => {
    setJourneyOpen(false)
    setAddOpen(false)
    reset()
  }, [reset])

  const onAdd = useCallback(
    (text: string) => {
      setAddOpen(false)
      addDecision(text)
    },
    [addDecision],
  )

  const label = loadingLabel(!!journey, confirmedDecisions.length)
  const showHome = phase === 'home' || (!journey && phase !== 'thinking')

  return (
    /* reducedMotion="user" makes every motion component below drop transforms
       and keep opacity when the OS asks for it. The .no-motion class only
       reaches CSS transitions, which is not where most of the movement is. */
    <MotionConfig reducedMotion="user">
    <div className={`app ${reduced ? 'no-motion' : ''}`}>
      <div className="app__frame">
        <div className={`aura ${phase === 'confirming' ? 'aura--commit' : ''}`} aria-hidden />
        <div className="grain" aria-hidden />

        <AnimatePresence mode="wait" initial={false}>
          {phase === 'error' && error ? (
            <motion.div key="error" className="screen" {...screenMotion}>
              <ErrorState error={error} onRetry={retry} onLeave={leave} />
            </motion.div>
          ) : showHome ? (
            <motion.div key="home" className="screen" {...screenMotion}>
              <LockHome onStart={start} />
            </motion.div>
          ) : complete && journey ? (
            <motion.div key="complete" className="screen" {...screenMotion}>
              <JourneyComplete
                journey={journey}
                decisions={confirmedDecisions}
                closing={step.kind === 'complete' ? step.closing : ''}
                onRestart={leave}
                onAddDecision={() => setAddOpen(true)}
              />
            </motion.div>
          ) : journey ? (
            <motion.div key="workspace" className="screen" {...screenMotion}>
              <DecisionWorkspace
                journey={journey}
                step={step}
                phase={phase}
                settling={state.settling}
                pendingDecision={pendingDecision}
                reduced={reduced}
                loadingLabel={label}
                onAnswer={answer}
                onConfirm={confirm}
                onConfirmationDone={confirmationDone}
                onOpenJourney={() => setJourneyOpen(true)}
                onAddDecision={() => setAddOpen(true)}
                onLeave={leave}
              />
            </motion.div>
          ) : (
            /* The very first turn, before a journey exists. */
            <motion.div key="opening" className="screen" {...screenMotion}>
              <div className="screen__body opening">
                <OpeningState label={label} reduced={reduced} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {journey && (
          <DecisionJourneySheet
            open={journeyOpen}
            journey={journey}
            pendingId={pendingDecision?.id ?? null}
            onClose={() => setJourneyOpen(false)}
            onAdd={() => {
              setJourneyOpen(false)
              setAddOpen(true)
            }}
          />
        )}

        <AddDecisionSheet open={addOpen} onClose={() => setAddOpen(false)} onAdd={onAdd} />
      </div>
    </div>
    </MotionConfig>
  )
}

function OpeningState({ label, reduced }: { label: string; reduced: boolean }) {
  return <LoadingState label={label} reduced={reduced} />
}
