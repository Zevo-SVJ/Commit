import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useState } from 'react'
import AddDecisionSheet from './components/AddDecisionSheet'
import DecisionHome from './components/DecisionHome'
import DecisionJourneySheet from './components/DecisionJourney'
import DecisionWorkspace from './components/DecisionWorkspace'
import JourneyComplete from './components/JourneyComplete'
import Reading from './components/Reading'
import type { EntryMode } from './lib/engine'
import { useAppViewport, usePrefersReducedMotion } from './lib/useAppViewport'
import { useJourney } from './lib/useJourney'

const screenMotion = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.42, ease: [0.22, 1, 0.36, 1] as const },
}

export default function App() {
  useAppViewport()
  const reduced = usePrefersReducedMotion()

  const {
    state,
    beat,
    activeDecision,
    confirmedDecisions,
    visibleDecisions,
    start,
    startDemo,
    readingDone,
    advance,
    answer,
    confirm,
    transitionDone,
    addDecision,
    reset,
  } = useJourney()

  const [journeyOpen, setJourneyOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)

  /* The flow itself can ask for the add-decision sheet (the §33 fallback). */
  useEffect(() => {
    if (state.addDecisionRequest > 0) {
      setJourneyOpen(false)
      setAddOpen(true)
    }
  }, [state.addDecisionRequest])

  /* Browser back leaves the journey instead of leaving the site. */
  useEffect(() => {
    if (state.screen === 'home') return
    window.history.pushState({ commit: true }, '')
    const onPop = () => {
      if (addOpen || journeyOpen) {
        setAddOpen(false)
        setJourneyOpen(false)
        window.history.pushState({ commit: true }, '')
        return
      }
      reset()
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
    // Re-armed whenever we enter a new screen so one back press is one step.
  }, [state.screen, reset, addOpen, journeyOpen])

  const leave = useCallback(() => {
    setJourneyOpen(false)
    setAddOpen(false)
    reset()
  }, [reset])

  const onAdd = useCallback(
    (text: string) => {
      addDecision(text)
      setAddOpen(false)
    },
    [addDecision],
  )

  const onStart = useCallback(
    (input: string, mode: EntryMode) => start(input, mode),
    [start],
  )

  const committing = state.transition !== null

  return (
    <div className={`app ${reduced ? 'no-motion' : ''}`}>
      <div className="app__frame">
        <div className={`aura ${committing ? 'aura--commit' : ''}`} aria-hidden />
        <div className="grain" aria-hidden />

        <AnimatePresence mode="wait" initial={false}>
          {state.screen === 'home' && (
            <motion.div key="home" className="screen" {...screenMotion}>
              <DecisionHome onStart={onStart} onDemo={startDemo} />
            </motion.div>
          )}

          {state.screen === 'reading' && (
            <motion.div key="reading" className="screen" {...screenMotion}>
              <Reading lines={state.reading} onDone={readingDone} reduced={reduced} />
            </motion.div>
          )}

          {state.screen === 'workspace' && state.journey && (
            <motion.div key="workspace" className="screen" {...screenMotion}>
              <DecisionWorkspace
                journey={state.journey}
                beat={beat}
                activeDecision={activeDecision}
                transitionFinal={state.transition ? state.transition.final : null}
                progressDirection={state.progressDirection}
                reduced={reduced}
                onAnswer={answer}
                onAdvance={advance}
                onConfirm={confirm}
                onTransitionDone={transitionDone}
                onOpenJourney={() => setJourneyOpen(true)}
                onAddDecision={() => setAddOpen(true)}
                onLeave={leave}
              />
            </motion.div>
          )}

          {state.screen === 'complete' && state.journey && (
            <motion.div key="complete" className="screen" {...screenMotion}>
              <JourneyComplete
                journey={state.journey}
                decisions={confirmedDecisions}
                onRestart={leave}
                onAddDecision={() => setAddOpen(true)}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {state.journey && (
          <DecisionJourneySheet
            open={journeyOpen}
            journey={state.journey}
            decisions={visibleDecisions}
            activeId={activeDecision?.id ?? null}
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
  )
}
