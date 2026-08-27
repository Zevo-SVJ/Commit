import type {
  LockErrorBody,
  LockHistoryMessage,
  LockVerdictRequest,
  LockVerdictResponse,
} from '../../shared/verdict.ts'
import type { DecisionJourney, Step } from '../../shared/types.ts'
import { CLIENT_TIMEOUT_MS } from '../../shared/timeouts.ts'

/**
 * The client half of Lock's verdict engine.
 *
 * Same shape as `api.ts`: status before body, one request, no silent retry,
 * and every failure classified rather than collapsed. No secret is involved —
 * the model is called on the server, from Lock's own endpoint.
 */

export class VerdictUnavailable extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'VerdictUnavailable'
    this.code = code
  }
}

/** Lock's own journey, expressed in the verdict engine's vocabulary. */
export function verdictRequestFor(
  journey: DecisionJourney,
  step: Step | null,
  answer: string,
): LockVerdictRequest {
  const state =
    step?.kind === 'decision'
      ? 'awaiting_confirmation'
      : step?.kind === 'complete'
        ? 'complete'
        : 'awaiting_answer'

  const decision =
    step?.kind === 'decision'
      ? step.decision.question
      : journey.understanding.objective || journey.originalSituation

  // The engine caps history at 50 messages; each exchange is two.
  const history: LockHistoryMessage[] = []
  for (const e of journey.exchanges.slice(-24)) {
    if (e.question) history.push({ role: 'lock', content: e.question.slice(0, 4000) })
    if (e.answer) history.push({ role: 'user', content: e.answer.slice(0, 4000) })
  }
  if (step?.kind === 'question' && step.prompt) {
    history.push({ role: 'lock', content: step.prompt.slice(0, 4000) })
  }

  return {
    journey: {
      id: journey.id.slice(0, 200),
      state,
      decision: (decision || 'An open decision.').slice(0, 2000),
    },
    history: history.slice(-50),
    answer: answer.slice(0, 8000),
  }
}

export async function takeVerdict(
  request: LockVerdictRequest,
  signal?: AbortSignal,
): Promise<LockVerdictResponse> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort)

  try {
    let res: Response
    try {
      res = await fetch('/api/verdict', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      })
    } catch (err) {
      if (signal?.aborted) throw new DOMException('cancelled', 'AbortError')
      if ((err as Error)?.name === 'AbortError' || controller.signal.aborted) {
        throw new VerdictUnavailable('ai_unavailable', 'The decision engine did not answer in time.')
      }
      throw new VerdictUnavailable('ai_unavailable', 'The decision engine could not be reached.')
    }

    const raw = await res.text().catch(() => '')
    let payload: unknown = null
    try {
      payload = raw ? JSON.parse(raw) : null
    } catch {
      throw new VerdictUnavailable('internal_error', 'The decision engine answered unreadably.')
    }

    if (!res.ok) {
      const e = (payload as LockErrorBody)?.error
      throw new VerdictUnavailable(e?.code ?? 'internal_error', e?.message ?? 'The decision engine failed.')
    }

    // The server validates the model; the client validates the server.
    const v = payload as LockVerdictResponse
    if (!v || typeof v.verdict !== 'string' || typeof v.action !== 'string') {
      throw new VerdictUnavailable('invalid_ai_output', 'The decision engine returned an unusable verdict.')
    }
    return v
  } finally {
    window.clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
