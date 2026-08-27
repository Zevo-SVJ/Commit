import {
  InvalidVerdictOutput,
  VERDICT_JSON_SCHEMA,
  lockError,
  parseVerdict,
  validateVerdictRequest,
  type LockErrorCode,
  type LockVerdictRequest,
  type LockVerdictResponse,
} from '../shared/verdict.js'
import { LOCK_SYSTEM_PROMPT, buildVerdictPrompt } from './ai/verdict-prompt.js'
import { createProvider } from './ai/factory.js'
import { ProviderError, TimeoutAbort, isAbortError, type Provider } from './ai/provider.js'
import { PROVIDER_TIMEOUT_MS } from '../shared/timeouts.js'

/**
 * The Lock verdict engine, ported from the `lock-ai-logic` backend
 * (`src/lib/lock-decision.server.ts`).
 *
 * The logic is preserved: one generation per request, never retried, the
 * result validated against the Lock schema before anyone sees it, and the
 * provider's own failures mapped to the published error codes.
 *
 * What changed is who generates. The original called Lovable's AI gateway with
 * a `LOVABLE_API_KEY`; this runs on Lock's existing provider seam, so it uses
 * the same OpenRouter credential, the same catalogue-resolved model, the same
 * timeout ladder and the same key-handling as the rest of Lock. That is the
 * whole point of bringing it in-house: one backend, one secret, one place
 * where a model is called.
 */

export interface VerdictResult {
  status: number
  body: LockVerdictResponse | ReturnType<typeof lockError>
}

/** The published error codes, mapped from Lock's provider vocabulary. */
function fromProviderError(err: ProviderError): { status: number; code: LockErrorCode; message: string } {
  switch (err.kind) {
    case 'unconfigured':
      return { status: 503, code: 'ai_not_configured', message: 'AI is not configured for this backend.' }
    case 'auth':
      return { status: 503, code: 'ai_not_configured', message: 'AI access is not available for this backend.' }
    case 'quota':
      return { status: 402, code: 'ai_not_configured', message: 'AI credits are exhausted for this workspace.' }
    case 'rate_limited':
      return { status: 429, code: 'rate_limited', message: 'AI rate limit reached. Retry this turn shortly.' }
    case 'timeout':
      return { status: 504, code: 'ai_unavailable', message: 'The Lock decision turn could not be completed in time.' }
    case 'cancelled':
      return { status: 499, code: 'ai_unavailable', message: 'The request was cancelled.' }
    case 'model_unavailable':
    case 'bad_request':
      return { status: 502, code: 'ai_unavailable', message: 'The AI service is temporarily unavailable.' }
    default:
      return { status: 502, code: 'ai_unavailable', message: 'The AI service is temporarily unavailable.' }
  }
}

/**
 * Exactly one generation for one Lock turn, validated. No retries, no second
 * generation — the same guarantee the original backend gave.
 */
export async function runVerdict(
  input: LockVerdictRequest,
  provider: Provider = createProvider(),
  signal?: AbortSignal,
): Promise<VerdictResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new TimeoutAbort(PROVIDER_TIMEOUT_MS)), PROVIDER_TIMEOUT_MS)
  const onCallerGone = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) onCallerGone()
    else signal.addEventListener('abort', onCallerGone, { once: true })
  }

  const started = Date.now()
  try {
    const raw = await provider(
      {
        brief: buildVerdictPrompt(input),
        instruction: 'Return the Lock decision object for this turn.',
        system: LOCK_SYSTEM_PROMPT,
        schema: { name: 'lock_verdict', schema: VERDICT_JSON_SCHEMA },
      },
      controller.signal,
    )

    const decision = parseVerdict(raw)
    console.log(
      `[lock] verdict ${decision.verdict}/${decision.action} in ${Date.now() - started}ms`,
    )
    return { status: 200, body: decision }
  } catch (err) {
    if (err instanceof InvalidVerdictOutput) {
      console.error('[lock] verdict rejected:', err.message)
      return {
        status: 502,
        body: lockError(
          'invalid_ai_output',
          'The AI returned a response that does not match the Lock decision schema.',
        ),
      }
    }
    if (err instanceof ProviderError) {
      // Never surface raw provider payloads or credentials to the client.
      console.error('[lock] verdict generation failed', {
        kind: err.kind,
        status: err.status ?? null,
        providerCode: err.providerCode ?? null,
      })
      const mapped = fromProviderError(err)
      return { status: mapped.status, body: lockError(mapped.code, mapped.message) }
    }
    if (isAbortError(err)) {
      return {
        status: 504,
        body: lockError('ai_unavailable', 'The Lock decision turn could not be completed in time.'),
      }
    }
    console.error('[lock] verdict failed:', err instanceof Error ? err.name : typeof err)
    return { status: 500, body: lockError('internal_error', 'The decision turn could not be completed.') }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onCallerGone)
  }
}

/** Validates the request, then runs it. The whole endpoint, minus the host. */
export async function handleVerdict(
  body: unknown,
  provider: Provider = createProvider(),
  signal?: AbortSignal,
): Promise<VerdictResult> {
  const parsed = validateVerdictRequest(body)
  if (!parsed.ok) {
    return { status: 400, body: lockError('invalid_request', parsed.message) }
  }
  return runVerdict(parsed.value, provider, signal)
}
