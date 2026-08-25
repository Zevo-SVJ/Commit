import { useCallback, useEffect, useRef, useState } from 'react'
import type { DecisionJourney, Step, TurnEvent } from '../../shared/types.ts'
import { LockRequestError, takeTurn, type LockError } from './api.ts'
import { load, save } from './persistence.ts'

/**
 * All of LOCK's state logic. Components below this render what it produces and
 * nothing more — no component talks to the network.
 */

export type Phase =
  /** Nothing started. */
  | 'home'
  /** A turn is in flight and the screen is waiting on it. */
  | 'thinking'
  /** A step is on screen. */
  | 'step'
  /** The user has slid; the confirmation is playing. */
  | 'confirming'
  | 'error'

export interface JourneyState {
  phase: Phase
  journey: DecisionJourney | null
  step: Step | null
  error: LockError | null
  /** True while the confirmation is waiting on a turn that has not landed. */
  settling: boolean
  /** A turn is in flight underneath a confirmation that is still playing. */
  turnPending: boolean
}

const INITIAL: JourneyState = {
  phase: 'home',
  journey: null,
  step: null,
  error: null,
  settling: false,
  turnPending: false,
}

export function useJourney() {
  const [state, setState] = useState<JourneyState>(INITIAL)

  /** The event to replay if the user retries. */
  const lastEvent = useRef<{ journey: DecisionJourney | null; event: TurnEvent } | null>(null)
  const abort = useRef<AbortController | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      abort.current?.abort()
    }
  }, [])

  /* ---- restore an unfinished journey ----------------------------- */

  useEffect(() => {
    const saved = load()
    if (!saved) return
    setState({
      phase: 'step',
      journey: saved.journey,
      step: saved.step,
      error: null,
      settling: false,
      turnPending: false,
    })
  }, [])

  useEffect(() => {
    if (state.journey && state.step && state.phase === 'step') {
      save({ journey: state.journey, step: state.step })
    }
  }, [state.journey, state.step, state.phase])

  /* ---- the one path to the server -------------------------------- */

  const run = useCallback(
    async (
      journey: DecisionJourney | null,
      event: TurnEvent,
      opts: { silent?: boolean } = {},
    ) => {
      lastEvent.current = { journey, event }
      abort.current?.abort()
      const controller = new AbortController()
      abort.current = controller

      // A confirmation keeps its own screen: the animation must not be
      // interrupted by a loading state behind it.
      if (!opts.silent) {
        setState((s) => ({ ...s, phase: 'thinking', error: null }))
      }

      try {
        const turn = await takeTurn(journey, event, controller.signal)
        if (!alive.current || controller.signal.aborted) return
        setState((s) => ({
          ...s,
          // A confirmation still playing owns the screen until its animation
          // ends — the result is held back rather than cutting it short.
          // If the animation already finished and was waiting, release it now.
          phase: s.phase === 'confirming' && !s.settling ? 'confirming' : 'step',
          journey: turn.journey,
          step: turn.step,
          error: null,
          settling: false,
          turnPending: false,
        }))
      } catch (err) {
        if (!alive.current || (err as Error)?.name === 'AbortError') return
        const e =
          err instanceof LockRequestError
            ? { code: err.code, message: err.message, retryable: err.retryable }
            : { code: 'upstream' as const, message: 'Something went wrong.', retryable: true }
        // The journey is never destroyed by a failed turn.
        setState((s) => ({ ...s, phase: 'error', error: e, settling: false, turnPending: false }))
      }
    },
    [],
  )

  /* ---- actions ---------------------------------------------------- */

  const start = useCallback(
    (input: string) => {
      save(null)
      setState({ ...INITIAL, phase: 'thinking' })
      void run(null, { type: 'start', input })
    },
    [run],
  )

  const answer = useCallback(
    (text: string) => {
      if (!state.journey) return
      // The question travels with the answer so the journey can record the
      // pair verbatim, which is what stops it being asked again.
      const question = state.step?.kind === 'question' ? state.step.prompt : undefined
      void run(state.journey, { type: 'answer', text, question })
    },
    [run, state.journey, state.step],
  )

  const addDecision = useCallback(
    (text: string) => {
      if (!state.journey) return
      void run(state.journey, { type: 'addDecision', text })
    },
    [run, state.journey],
  )

  /**
   * The slide has completed. The confirmation plays immediately and the turn
   * is fetched underneath it — the user never waits on the network to see that
   * their gesture registered.
   */
  const confirm = useCallback(
    (decisionId: string) => {
      if (!state.journey) return
      setState((s) => ({
        ...s,
        phase: 'confirming',
        error: null,
        settling: false,
        turnPending: true,
      }))
      void run(state.journey, { type: 'confirm', decisionId }, { silent: true })
    },
    [run, state.journey],
  )

  /** Called when the confirmation animation finishes playing. */
  const confirmationDone = useCallback(() => {
    setState((s) => {
      if (s.phase !== 'confirming') return s
      // Still waiting on the server: hold the confirmed state rather than
      // dropping the user back onto the decision they just committed to.
      if (s.turnPending) return { ...s, settling: true }
      return { ...s, phase: 'step', settling: false }
    })
  }, [])

  const retry = useCallback(() => {
    const last = lastEvent.current
    if (!last) return
    void run(last.journey, last.event)
  }, [run])

  const reset = useCallback(() => {
    abort.current?.abort()
    save(null)
    setState(INITIAL)
  }, [])

  /* ---- derived ---------------------------------------------------- */

  const pendingDecision =
    state.step?.kind === 'decision' && state.step.decision.status === 'pending'
      ? state.step.decision
      : null

  const confirmedDecisions = (state.journey?.decisions ?? []).filter(
    (d) => d.status === 'confirmed',
  )

  return {
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
  }
}
