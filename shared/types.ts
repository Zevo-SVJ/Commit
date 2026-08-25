/**
 * The contract between the Lock client and the Lock server.
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
 * What Lock currently believes. Rewritten by the model each turn rather than
 * appended to, so the journey compresses as it goes instead of accumulating.
 */
export interface Understanding {
  /** The single thing the user is trying to resolve. */
  objective: string
  /** Facts that matter, in Lock's words, not the user's. */
  known: string[]
  /** Things still unknown that could matter. */
  openQuestions: string[]
  /** The one unknown that most affects the outcome, if there is one. */
  criticalUnknown: string | null
  /** A tension between what the user wants and what they have said. */
  contradiction: string | null
}

/** One question Lock asked, and what the user actually said back. */
export interface Exchange {
  question: string
  answer: string
}

export interface DecisionJourney {
  id: string
  /** Exactly what the user typed at the start. Never rewritten. */
  originalSituation: string
  title: string
  understanding: Understanding
  /**
   * Verbatim, uncompressed, and capped. `understanding.known` is Lock's
   * compressed read and can legitimately drop things; this is the guarantee
   * that a question is never asked twice and that nothing the user said is
   * silently lost when the model rewrites its own notes.
   */
  exchanges: Exchange[]
  decisions: Decision[]
  /**
   * The decision awaiting a slide, by id rather than by value so it cannot
   * drift out of step with `decisions`.
   */
  currentDecisionId: string | null
  /** What happens next, in a sentence. Internal; never rendered. */
  nextStep: string
  /** 0..1. How resolved the journey is. May fall when new information lands. */
  progress: number
  /** 0..1. How sure Lock is about its own read. */
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
   * A tension between what the user wants and what they have told us. Shown
   * once, when it first appears — Lock disagreeing, not nagging.
   */
  contradiction: string | null
  /**
   * At most one sentence of new framing, shown above the question. Null unless
   * Lock has something to add that the user did not already say.
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
  contradiction: string | null
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
  /** `question` is carried so the journey can record the pair verbatim. */
  | { type: 'answer'; text: string; question?: string }
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
  /** No key reached the server. */
  | 'unconfigured'
  /** A key was sent and the provider rejected it. */
  | 'auth'
  /** HTTP 429 because the account has no credit. Waiting will not help. */
  | 'quota'
  /** HTTP 429 because of a real requests/tokens-per-minute limit. */
  | 'rate_limited'
  /** The configured model is not available to this account. */
  | 'model_unavailable'
  /** The provider refused the request itself — a schema or parameter fault. */
  | 'model_request_rejected'
  | 'timeout'
  | 'upstream'
  /** The model answered, but not with a usable turn. */
  | 'invalid_response'
  | 'bad_request'
  /** The function could not load its own modules. */
  | 'server_boot'
  /** The function threw before it could answer. */
  | 'server_crash'
  /** /api/decision is not deployed. */
  | 'not_found'
  /** Something answered, but it was not our handler. */
  | 'unreachable'
  /** The request never left the browser. */
  | 'offline'

export interface ApiError {
  error: {
    code: ApiErrorCode
    /** Safe to show a user. Never contains provider detail or key material. */
    message: string
    retryable: boolean
    /** One line naming where it broke. No secrets, no journey content. */
    detail?: string
  }
}
