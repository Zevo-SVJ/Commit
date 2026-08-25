/**
 * The contract between the LOCK client and the LOCK server.
 *
 * Both sides import this file. The server is the only thing that talks to a
 * model, and it never returns anything that has not been validated against
 * these shapes — the client renders deterministically from them.
 */

export type DecisionSource = 'lock' | 'user'
export type DecisionStatus = 'pending' | 'confirmed'
export type JourneyStatus = 'active' | 'complete'

export interface Decision {
  id: string
  /** The decision as a question: "Should I pursue the partnership?" */
  question: string
  /** What sliding actually commits to: "Pursue the partnership." */
  commitment: string
  /** One line. Why this is the decision, not a summary of the user's words. */
  rationale: string
  context: string | null
  source: DecisionSource
  status: DecisionStatus
  importance: 'pivotal' | 'standard'
  isFinal: boolean
  createdAt: number
  confirmedAt: number | null
}

/**
 * What LOCK currently believes. Rewritten by the model each turn rather than
 * appended to, so the journey compresses as it goes instead of accumulating.
 */
export interface Understanding {
  /** The single thing the user is trying to resolve. */
  objective: string
  /** Facts that matter, in LOCK's words, not the user's. */
  known: string[]
  /** Things still unknown that could matter. */
  openQuestions: string[]
  /** The one unknown that most affects the outcome, if there is one. */
  criticalUnknown: string | null
  /** A tension between what the user wants and what they have said. */
  contradiction: string | null
}

export interface DecisionJourney {
  id: string
  /** Exactly what the user typed at the start. Never rewritten. */
  originalSituation: string
  title: string
  understanding: Understanding
  decisions: Decision[]
  /** 0..1. How resolved the journey is. May fall when new information lands. */
  progress: number
  /** 0..1. How sure LOCK is about its own read. */
  confidence: number
  status: JourneyStatus
  createdAt: number
  updatedAt: number
}

/* ------------------------------------------------------------------ */
/* Steps — what the client is told to put on screen next.              */
/* ------------------------------------------------------------------ */

export interface QuestionStep {
  kind: 'question'
  id: string
  prompt: string
  /**
   * At most one sentence of new framing, shown above the question. Null unless
   * LOCK has something to add that the user did not already say.
   */
  framing: string | null
  /** Tappable answers. May be empty when the question needs prose. */
  options: string[]
  allowFree: boolean
}

export interface DecisionStep {
  kind: 'decision'
  decision: Decision
  framing: string | null
}

export interface CompleteStep {
  kind: 'complete'
  /** One quiet closing line. Not a summary of what was decided. */
  closing: string
}

export type Step = QuestionStep | DecisionStep | CompleteStep

/* ------------------------------------------------------------------ */
/* Wire format                                                         */
/* ------------------------------------------------------------------ */

export type TurnEvent =
  | { type: 'start'; input: string }
  | { type: 'answer'; text: string }
  | { type: 'confirm'; decisionId: string }
  | { type: 'addDecision'; text: string }

export interface TurnRequest {
  /** Absent on the very first turn of a journey. */
  journey: DecisionJourney | null
  event: TurnEvent
}

export interface TurnResponse {
  journey: DecisionJourney
  step: Step
}

export type ApiErrorCode =
  | 'unconfigured'
  | 'rate_limited'
  | 'timeout'
  | 'upstream'
  | 'invalid_response'
  | 'bad_request'

export interface ApiError {
  error: {
    code: ApiErrorCode
    /** Safe to show a user. Never contains provider detail or key material. */
    message: string
    retryable: boolean
  }
}
