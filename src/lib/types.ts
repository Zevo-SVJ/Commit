/**
 * Domain model for Commit.
 *
 * This is the *internal* model of a decision journey. Almost none of it is
 * shown to the user directly — the UI deliberately surfaces one thing at a
 * time. The shape here is what a future intelligence layer would produce and
 * mutate; today it is produced by deterministic local logic in `engine.ts`.
 */

export type DecisionSource = 'user' | 'system'
export type DecisionStatus = 'proposed' | 'active' | 'confirmed'

export interface Decision {
  id: string
  /** The decision framed as a question the user is answering by committing. */
  question: string
  /** The commitment itself — what the user is agreeing to by sliding. */
  answer: string
  source: DecisionSource
  status: DecisionStatus
  /** Resolved at confirmation time, not authored up front. */
  is_final: boolean
  stage: number
  rationale: string
  timestamp: number | null
}

export type JourneyStatus = 'forming' | 'active' | 'resolved'

export interface DecisionJourney {
  id: string
  title: string
  original_problem: string
  current_stage: number
  decisions: Decision[]
  status: JourneyStatus
  /** 0..1 — how mature the journey is toward resolution. Can decrease. */
  internal_progress: number
  known_information: string[]
  unknown_information: string[]
  critical_unknowns: string[]
  next_action: string
  /**
   * True when the system cannot confidently tell whether the journey is done.
   * Only then does it fall back to asking the user (§33).
   */
  needsFinalCheck: boolean
}

/* ------------------------------------------------------------------ */
/* Beats — the unit of pacing. The workspace shows exactly one at a time. */
/* ------------------------------------------------------------------ */

export interface BeatBase {
  id: string
  /** Journey maturity once this beat is reached. */
  progressTo: number
}

export interface ContextBeat extends BeatBase {
  kind: 'context'
  label: string
  lead: string
  facts: string[]
}

export interface QuestionOption {
  id: string
  label: string
  effect?: BeatEffect
}

export interface QuestionBeat extends BeatBase {
  kind: 'question'
  prompt: string
  sub?: string
  options: QuestionOption[]
  allowFree?: boolean
  freePlaceholder?: string
  /** Applied when the user answers in their own words instead of picking. */
  freeEffect?: BeatEffect
}

export interface InsightBeat extends BeatBase {
  kind: 'insight'
  label: string
  body: string
  /** 'shift' marks new information that changed the shape of the problem. */
  tone?: 'neutral' | 'shift'
}

export interface DecisionBeat extends BeatBase {
  kind: 'decision'
  decisionId: string
}

export interface CompleteBeat extends BeatBase {
  kind: 'complete'
}

export type Beat =
  | ContextBeat
  | QuestionBeat
  | InsightBeat
  | DecisionBeat
  | CompleteBeat

/** What answering a question does to the journey. */
export interface BeatEffect {
  /** Beats spliced in immediately after the question. */
  insert?: Beat[]
  /** Beats added to the end of the queue — work that comes after the next decision. */
  append?: Beat[]
  /** Override journey maturity — may be *lower* than current. */
  progressTo?: number
  /**
   * Rewrite a queued decision *from the user's own words*, when the answer is
   * free text rather than one of the options. Carries the decision's id.
   */
  patchDecisionFromAnswer?: string
  /** Rewrite a queued decision in light of the answer. */
  patchDecision?: {
    decisionId: string
    question?: string
    answer?: string
    rationale?: string
  }
  known?: string[]
  unknown?: string[]
  criticalUnknowns?: string[]
  /** Resolve the ambiguity that would otherwise trigger the final-check. */
  clearFinalCheck?: boolean
  /** Ends the journey immediately after this answer. */
  complete?: boolean
  /** Ask the user to write a decision of their own. */
  promptUserDecision?: boolean
}

/** A fully authored (or generated) scenario, ready to run. */
export interface Scenario {
  journey: DecisionJourney
  beats: Beat[]
  /** Lines shown during the brief "understanding" moment before the workspace. */
  reading: string[]
}
