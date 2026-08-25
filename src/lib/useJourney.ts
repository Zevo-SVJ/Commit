import { useCallback, useMemo, useReducer } from 'react'
import {
  finalCheckBeat,
  phraseFromInput,
  resolvesJourney,
  titleFromInput,
  scenarioForDemo,
  scenarioForInput,
  type DemoId,
  type EntryMode,
} from './engine'
import { uid } from './scenarios'
import type {
  Beat,
  BeatEffect,
  Decision,
  DecisionBeat,
  DecisionJourney,
  QuestionBeat,
  Scenario,
} from './types'

export type Screen = 'home' | 'reading' | 'workspace' | 'complete'

export interface Transition {
  /** Bumped every time so the overlay remounts cleanly. */
  token: number
  decisionId: string
  final: boolean
}

export interface JourneyState {
  screen: Screen
  journey: DecisionJourney | null
  beats: Beat[]
  index: number
  reading: string[]
  transition: Transition | null
  /** Bumped when the flow itself wants the "add a decision" sheet opened. */
  addDecisionRequest: number
  /** Direction of the last progress change — the bar animates differently. */
  progressDirection: 'up' | 'down'
}

const initialState: JourneyState = {
  screen: 'home',
  journey: null,
  beats: [],
  index: 0,
  reading: [],
  transition: null,
  addDecisionRequest: 0,
  progressDirection: 'up',
}

type Action =
  | { type: 'start'; input: string; mode: EntryMode }
  | { type: 'startDemo'; demo: DemoId }
  | { type: 'readingDone' }
  | { type: 'advance' }
  | { type: 'answer'; optionId?: string; free?: string }
  | { type: 'confirm'; decisionId: string }
  | { type: 'transitionDone' }
  | { type: 'addDecision'; text: string }
  | { type: 'reset' }

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

function begin(scenario: Scenario): JourneyState {
  return {
    ...initialState,
    screen: 'reading',
    journey: scenario.journey,
    beats: scenario.beats,
    reading: scenario.reading,
    index: 0,
  }
}

function withProgress(state: JourneyState, journey: DecisionJourney, next: number): JourneyState {
  const value = clamp01(next)
  return {
    ...state,
    journey: { ...journey, internal_progress: value },
    progressDirection: value < journey.internal_progress - 0.001 ? 'down' : 'up',
  }
}

/** Applies everything an answer does to the journey and the beat queue. */
function applyEffect(
  state: JourneyState,
  journey: DecisionJourney,
  effect: BeatEffect | undefined,
  extraKnown?: string,
  freeText?: string,
): JourneyState {
  let beats = state.beats
  const at = state.index

  if (effect?.insert?.length) {
    beats = [...beats.slice(0, at + 1), ...effect.insert, ...beats.slice(at + 1)]
  }
  if (effect?.append?.length) {
    beats = [...beats, ...effect.append]
  }

  let decisions = journey.decisions
  let title = journey.title

  // The user naming the decision in their own words replaces the system's
  // placeholder wording — and gives the journey its name.
  if (effect?.patchDecisionFromAnswer && freeText) {
    const phrased = phraseFromInput(freeText)
    decisions = decisions.map((d) =>
      d.id === effect.patchDecisionFromAnswer
        ? {
            ...d,
            question: phrased.question,
            answer: phrased.commitment,
            rationale: 'You named this one yourself.',
          }
        : d,
    )
    title = titleFromInput(freeText)
  }

  if (effect?.patchDecision) {
    const patch = effect.patchDecision
    decisions = decisions.map((d) =>
      d.id === patch.decisionId
        ? {
            ...d,
            question: patch.question ?? d.question,
            answer: patch.answer ?? d.answer,
            rationale: patch.rationale ?? d.rationale,
          }
        : d,
    )
  }

  const nextJourney: DecisionJourney = {
    ...journey,
    decisions,
    title,
    known_information: [
      ...journey.known_information,
      ...(effect?.known ?? []),
      ...(extraKnown ? [extraKnown] : []),
    ],
    unknown_information: [...journey.unknown_information, ...(effect?.unknown ?? [])],
    critical_unknowns: [...journey.critical_unknowns, ...(effect?.criticalUnknowns ?? [])],
    needsFinalCheck: effect?.clearFinalCheck ? false : journey.needsFinalCheck,
  }

  const nextIndex = at + 1
  const target = effect?.progressTo ?? beats[nextIndex]?.progressTo ?? journey.internal_progress

  const advanced: JourneyState = {
    ...state,
    beats,
    index: nextIndex,
    addDecisionRequest: effect?.promptUserDecision
      ? state.addDecisionRequest + 1
      : state.addDecisionRequest,
  }

  const withNewProgress = withProgress(advanced, nextJourney, target)

  if (effect?.complete) {
    return {
      ...withNewProgress,
      screen: 'complete',
      journey: { ...withNewProgress.journey!, status: 'resolved', internal_progress: 1 },
    }
  }
  return withNewProgress
}

function reducer(state: JourneyState, action: Action): JourneyState {
  switch (action.type) {
    case 'start':
      return begin(scenarioForInput(action.input, action.mode))

    case 'startDemo':
      return begin(scenarioForDemo(action.demo))

    case 'readingDone':
      return { ...state, screen: 'workspace' }

    case 'advance': {
      const { journey } = state
      if (!journey) return state
      const nextIndex = Math.min(state.index + 1, state.beats.length - 1)
      const target = state.beats[nextIndex]?.progressTo ?? journey.internal_progress
      return withProgress({ ...state, index: nextIndex }, journey, target)
    }

    case 'answer': {
      const { journey } = state
      const beat = state.beats[state.index]
      if (!journey || !beat || beat.kind !== 'question') return state
      const q = beat as QuestionBeat

      if (action.optionId) {
        const option = q.options.find((o) => o.id === action.optionId)
        if (!option) return state
        return applyEffect(state, journey, option.effect, option.label)
      }

      const free = (action.free ?? '').trim()
      if (!free) return state
      return applyEffect(state, journey, q.freeEffect, free, free)
    }

    case 'confirm': {
      const { journey } = state
      if (!journey || state.transition) return state
      const decision = journey.decisions.find((d) => d.id === action.decisionId)
      if (!decision || decision.status === 'confirmed') return state

      let beats = state.beats
      let needsFinalCheck = journey.needsFinalCheck

      // The system only asks whether more remains when it genuinely cannot tell.
      const laterDecision = beats.slice(state.index + 1).some((b) => b.kind === 'decision')
      let asking = false
      if (!laterDecision && needsFinalCheck) {
        beats = [...beats, finalCheckBeat()]
        needsFinalCheck = false
        asking = true
      }

      // If we are about to ask whether anything remains, this cannot be the
      // decision that ends the journey — the user has not answered yet.
      const final = asking
        ? false
        : resolvesJourney(beats, state.index, { ...journey, needsFinalCheck }, action.decisionId)

      const decisions = journey.decisions.map((d) =>
        d.id === action.decisionId
          ? { ...d, status: 'confirmed' as const, is_final: final, timestamp: Date.now() }
          : d,
      )

      const nextJourney: DecisionJourney = {
        ...journey,
        decisions,
        needsFinalCheck,
        current_stage: journey.current_stage + 1,
        internal_progress: final ? 1 : clamp01(Math.max(journey.internal_progress, decision.stage * 0.001 + journey.internal_progress + 0.06)),
      }

      return {
        ...state,
        beats,
        journey: nextJourney,
        progressDirection: 'up',
        transition: { token: Date.now(), decisionId: action.decisionId, final },
      }
    }

    case 'transitionDone': {
      const { journey, transition } = state
      if (!journey || !transition) return state

      if (transition.final) {
        return {
          ...state,
          transition: null,
          screen: 'complete',
          journey: { ...journey, status: 'resolved', internal_progress: 1 },
        }
      }

      // Nothing left in the queue: the journey is over whatever the flags say.
      const nextIndex = state.index + 1
      if (nextIndex > state.beats.length - 1) {
        return {
          ...state,
          transition: null,
          screen: 'complete',
          journey: { ...journey, status: 'resolved', internal_progress: 1 },
        }
      }

      const target = state.beats[nextIndex]?.progressTo ?? journey.internal_progress
      return withProgress({ ...state, transition: null, index: nextIndex }, journey, target)
    }

    case 'addDecision': {
      const { journey } = state
      const text = action.text.trim()
      if (!journey || !text) return state

      const { question, commitment } = phraseFromInput(text)

      const own: Decision = {
        id: uid('dec'),
        question,
        answer: commitment,
        source: 'user',
        status: 'proposed',
        is_final: false,
        stage: journey.current_stage,
        rationale: 'You raised this yourself. It takes priority over anything I assumed.',
        timestamp: null,
      }

      const beat: DecisionBeat = {
        id: uid('b'),
        kind: 'decision',
        progressTo: clamp01(journey.internal_progress - 0.1),
        decisionId: own.id,
      }

      const reopening = state.screen === 'complete'
      const insertAt = reopening ? state.beats.length : state.index + 1
      const beats = [...state.beats.slice(0, insertAt), beat, ...state.beats.slice(insertAt)]

      const nextJourney: DecisionJourney = {
        ...journey,
        decisions: [...journey.decisions, own],
        // The user naming a decision removes the ambiguity the fallback exists for.
        needsFinalCheck: false,
        status: 'active',
        next_action: own.question,
      }

      const base: JourneyState = {
        ...state,
        beats,
        screen: 'workspace',
        index: reopening ? insertAt : state.index,
      }

      // New work means the journey is further from resolution than it was.
      return withProgress(base, nextJourney, journey.internal_progress - 0.1)
    }

    case 'reset':
      return initialState

    default:
      return state
  }
}

export function useJourney() {
  const [state, dispatch] = useReducer(reducer, initialState)

  const beat = state.beats[state.index] ?? null

  const activeDecision = useMemo(() => {
    if (!state.journey) return null
    if (state.transition) {
      return state.journey.decisions.find((d) => d.id === state.transition!.decisionId) ?? null
    }
    if (beat?.kind !== 'decision') return null
    return state.journey.decisions.find((d) => d.id === beat.decisionId) ?? null
  }, [state.journey, state.transition, beat])

  const confirmedDecisions = useMemo(
    () => (state.journey?.decisions ?? []).filter((d) => d.status === 'confirmed'),
    [state.journey],
  )

  /** Decisions the user can see in the journey sheet: confirmed, active, queued. */
  const visibleDecisions = useMemo(() => {
    if (!state.journey) return []
    const queued = new Set(
      state.beats.filter((b): b is DecisionBeat => b.kind === 'decision').map((b) => b.decisionId),
    )
    return state.journey.decisions.filter((d) => d.status === 'confirmed' || queued.has(d.id))
  }, [state.journey, state.beats])

  return {
    state,
    beat,
    activeDecision,
    confirmedDecisions,
    visibleDecisions,
    start: useCallback((input: string, mode: EntryMode) => dispatch({ type: 'start', input, mode }), []),
    startDemo: useCallback((demo: DemoId) => dispatch({ type: 'startDemo', demo }), []),
    readingDone: useCallback(() => dispatch({ type: 'readingDone' }), []),
    advance: useCallback(() => dispatch({ type: 'advance' }), []),
    answer: useCallback(
      (payload: { optionId?: string; free?: string }) => dispatch({ type: 'answer', ...payload }),
      [],
    ),
    confirm: useCallback((decisionId: string) => dispatch({ type: 'confirm', decisionId }), []),
    transitionDone: useCallback(() => dispatch({ type: 'transitionDone' }), []),
    addDecision: useCallback((text: string) => dispatch({ type: 'addDecision', text }), []),
    reset: useCallback(() => dispatch({ type: 'reset' }), []),
  }
}
