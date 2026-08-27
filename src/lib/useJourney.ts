import { useCallback, useEffect, useRef, useState } from 'react'
import type { DecisionJourney, Step, TurnEvent } from '../../shared/types.ts'
import { LockRequestError, takeTurn, type LockError } from './api.ts'
import { takeVerdict, verdictRequestFor } from './verdict.ts'
import type { LockVerdictResponse } from '../../shared/verdict.ts'
import { load, save } from './persistence.ts'

/**
 * All of Lock's state logic. Components below this render what it produces and
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
  /**
   * The last judgement the verdict engine made on a free-text answer.
   *
   * Recorded rather than rendered: Lock's screens are unchanged. It is here so
   * the decision that drove the flow is inspectable, and so a follow-up
   * question can be traced back to the verdict that asked for it.
   */
  lastVerdict: LockVerdictResponse | null
}

/**
 * Asks the verdict engine to judge one free-text answer.
 *
 * Never throws. A verdict that cannot be obtained is not a reason to block the
 * journey — the turn engine still runs, and if the model is genuinely down it
 * fails there, in Lock's existing error path, with a better message than this
 * one could give. Adding the gate can therefore never make Lock less reliable
 * than it was without it.
 */
async function runGate(
  journey: DecisionJourney,
  step: Step | null,
  text: string,
  signal: AbortSignal,
): Promise<LockVerdictResponse | null> {
  try {
    return await takeVerdict(verdictRequestFor(journey, step, text), signal)
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err
    console.warn('[lock] verdict unavailable; continuing to the turn')
    return null
  }
}

/**
 * Identifies a user action, so the same one arriving twice can be recognised.
 * Content matters, not identity: two taps of the same answer are one action.
 */
function actionKey(journey: DecisionJourney | null, event: TurnEvent): string {
  const detail =
    event.type === 'start'
      ? event.input
      : event.type === 'answer' || event.type === 'addDecision'
        ? event.text
        : event.type === 'confirm'
          ? event.decisionId
          : ''
  return `${journey?.id ?? 'new'}:${event.type}:${detail}`
}

const INITIAL: JourneyState = {
  phase: 'home',
  journey: null,
  step: null,
  error: null,
  settling: false,
  turnPending: false,
  lastVerdict: null,
}

export function useJourney() {
  const [state, setState] = useState<JourneyState>(INITIAL)

  /** The event to replay if the user retries. */
  const lastEvent = useRef<{ journey: DecisionJourney | null; event: TurnEvent } | null>(null)
  /**
   * The turn currently on the wire, and what it is for.
   *
   * Keyed by the action rather than merely counted, so a second tap of the
   * *same* thing is ignored while a genuinely different action still
   * supersedes the one in flight.
   */
  const inFlight = useRef<{ key: string; controller: AbortController } | null>(null)
  /**
   * Which turn is allowed to write to the screen. Only the newest one is: a
   * superseded turn that fails after a newer one started used to throw the
   * user onto an error screen while the newer turn was still running.
   */
  const seq = useRef(0)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      inFlight.current?.controller.abort()
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
      lastVerdict: null,
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
      opts: { silent?: boolean; gate?: Step | null } = {},
    ) => {
      const key = actionKey(journey, event)
      // The same tap, twice. One user action is one provider request.
      if (inFlight.current?.key === key) return

      lastEvent.current = { journey, event }
      inFlight.current?.controller.abort()
      const controller = new AbortController()
      inFlight.current = { key, controller }
      const mine = ++seq.current

      // A confirmation keeps its own screen: the animation must not be
      // interrupted by a loading state behind it.
      if (!opts.silent) {
        setState((s) => ({ ...s, phase: 'thinking', error: null }))
      }

      try {
        /* The verdict engine, when this is a free-text answer.
           It judges the answer before Lock spends a turn on it: an answer that
           needs more from the user becomes a follow-up question instead of a
           new step, and an unusable one stops the journey rather than dragging
           it forward. Tapped options skip it — they are unambiguous by
           construction, and gating them would spend a generation to learn
           nothing. */
        if (opts.gate !== undefined && journey && event.type === 'answer') {
          const verdict = await runGate(journey, opts.gate, event.text, controller.signal)
          if (!alive.current || mine !== seq.current) return

          if (verdict) {
            setState((s) => ({ ...s, lastVerdict: verdict }))

            if (verdict.action === 'ask_followup' && verdict.followup) {
              // The follow-up is the model's own words, rendered by the same
              // question card every other question uses.
              const asked = event.question ?? ''
              const nextJourney: DecisionJourney = {
                ...journey,
                exchanges: [...journey.exchanges, { question: asked, answer: event.text }].slice(-10),
              }
              setState((s) => ({
                ...s,
                phase: 'step',
                journey: nextJourney,
                step: {
                  kind: 'question',
                  id: `q_${Date.now().toString(36)}`,
                  prompt: verdict.followup!,
                  contradiction: null,
                  framing: null,
                  options: [],
                  allowFree: true,
                },
                error: null,
                settling: false,
                turnPending: false,
              }))
              return
            }

            if (verdict.action === 'abort') {
              setState((s) => ({
                ...s,
                phase: 'error',
                error: {
                  code: 'invalid_response',
                  message: 'Lock cannot take that forward.',
                  retryable: true,
                  diagnostic: `verdict ${verdict.verdict} · ${verdict.reason}`,
                },
                settling: false,
                turnPending: false,
              }))
              return
            }
          }
        }

        const turn = await takeTurn(journey, event, controller.signal)
        if (!alive.current || mine !== seq.current) return
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
        // A superseded turn never writes to the screen, whether it was
        // cancelled cleanly or came back with a failure after the fact.
        if (!alive.current || mine !== seq.current) return
        if ((err as Error)?.name === 'AbortError') return
        const e: LockError =
          err instanceof LockRequestError
            ? {
                code: err.code,
                message: err.message,
                retryable: err.retryable,
                // Without this the diagnostic is built and then thrown away,
                // which is how every failure looked identical.
                diagnostic: err.diagnostic,
              }
            : { code: 'upstream', message: 'Something went wrong.', retryable: true }
        // The journey is never destroyed by a failed turn.
        setState((s) => ({ ...s, phase: 'error', error: e, settling: false, turnPending: false }))
      } finally {
        if (inFlight.current?.controller === controller) inFlight.current = null
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
      // A tapped option is already unambiguous; only prose is worth judging.
      const tapped =
        state.step?.kind === 'question' && state.step.options.includes(text)
      void run(
        state.journey,
        { type: 'answer', text, question },
        tapped ? {} : { gate: state.step },
      )
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
    seq.current++
    inFlight.current?.controller.abort()
    inFlight.current = null
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
