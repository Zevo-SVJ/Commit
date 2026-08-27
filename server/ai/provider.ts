/**
 * The provider seam.
 *
 * Everything above this file — the handler, the turn validator, the whole
 * client — is written against `Provider` and knows nothing about who answers.
 * An implementation returns the model's raw JSON object, or throws a
 * ProviderError whose `kind` says what actually went wrong. The kinds are
 * deliberately about *situations*, not about any one vendor's status codes,
 * so a second provider maps onto them rather than widening them.
 */

export type ProviderErrorKind =
  /** The caller went away. Nobody is waiting for this answer. */
  | 'cancelled'
  /** No key configured at all. */
  | 'unconfigured'
  /** A key was sent and rejected. */
  | 'auth'
  /** The account has no credit. HTTP 429, but waiting will never help. */
  | 'quota'
  /** A genuine requests-per-minute or tokens-per-minute limit. */
  | 'rate_limited'
  /** The model name is unknown to this account. */
  | 'model_unavailable'
  /** The request itself was refused — a bad schema or parameter. */
  | 'bad_request'
  | 'timeout'
  | 'upstream'

export class ProviderError extends Error {
  // Plain fields rather than constructor parameter properties, so these files
  // run under Node's type-stripping without a build step.
  kind: ProviderErrorKind
  status: number | undefined
  /** Seconds the provider asked us to wait, when it said. */
  retryAfter: number | undefined
  /** The provider's own request id, for looking a failure up with them. */
  requestId: string | undefined
  /** The provider's error type/code, e.g. "insufficient_quota". */
  providerCode: string | undefined

  constructor(
    message: string,
    kind: ProviderErrorKind,
    extra: {
      status?: number
      retryAfter?: number
      requestId?: string
      providerCode?: string
    } = {},
  ) {
    super(message)
    this.name = 'ProviderError'
    this.kind = kind
    this.status = extra.status
    this.retryAfter = extra.retryAfter
    this.requestId = extra.requestId
    this.providerCode = extra.providerCode
  }
}

/**
 * Why a provider call was aborted.
 *
 * An AbortError on its own says nothing about whose decision it was, and that
 * distinction is the whole difference between "the model was too slow" and
 * "the user closed the tab". Both used to arrive as the same bare
 * `AbortError: This operation was aborted`, which then escaped classification
 * entirely and surfaced as HTTP 500 `upstream`.
 *
 * The reason travels on the signal itself, so any layer that sees the abort
 * can attribute it without being told separately.
 */
export class TimeoutAbort extends Error {
  ms: number
  constructor(ms: number) {
    super(`the server stopped waiting after ${ms}ms`)
    this.name = 'TimeoutAbort'
    this.ms = ms
  }
}

export class ClientGoneAbort extends Error {
  constructor() {
    super('the caller disconnected')
    this.name = 'ClientGoneAbort'
  }
}

/** Matched by name, so it survives being bundled twice. */
const named = (reason: unknown, name: string): boolean =>
  typeof reason === 'object' && reason !== null && (reason as { name?: unknown }).name === name

export const isTimeoutAbort = (reason: unknown): boolean => named(reason, 'TimeoutAbort')
export const isClientGoneAbort = (reason: unknown): boolean => named(reason, 'ClientGoneAbort')

/** True for the DOMException fetch throws, and for anything wearing its name. */
export function isAbortError(err: unknown): boolean {
  return (
    named(err, 'AbortError') ||
    named(err, 'TimeoutAbort') ||
    named(err, 'ClientGoneAbort') ||
    (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 20)
  )
}

/**
 * Turns any failure raised during a provider exchange into a ProviderError.
 *
 * This is the net that was missing. Only the `fetch()` call used to be inside
 * a try/catch, so an abort landing during the *body read* — which is exactly
 * where a slow streaming model spends its time — threw a bare DOMException
 * that no layer recognised. It travelled all the way to the handler's
 * catch-all and became `HTTP 500 · upstream · AbortError`.
 */
export function providerFailure(
  err: unknown,
  signal: AbortSignal,
  context: string,
): ProviderError {
  if (isAbortError(err) || signal.aborted) {
    const reason = signal.reason
    if (isClientGoneAbort(reason)) {
      return new ProviderError(`cancelled while ${context}`, 'cancelled')
    }
    if (isTimeoutAbort(reason)) {
      return new ProviderError(
        `model call timed out while ${context} — ${(reason as Error).message}`,
        'timeout',
      )
    }
    // Aborted, but nobody claimed it: the platform, or a signal we did not
    // create. A timeout is the honest reading, and it is retryable.
    return new ProviderError(`model call aborted while ${context}`, 'timeout')
  }
  if (err instanceof ProviderError) return err
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  return new ProviderError(`could not reach the model while ${context} — ${detail}`, 'upstream')
}

export interface ProviderRequest {
  /** The conversation so far, already compressed into a compact brief. */
  brief: string
  instruction: string
  /**
   * A different contract than the journey turn.
   *
   * Lock asks a model two distinct questions — "what is the next step of this
   * journey" and "is this answer usable" — and they need different system
   * prompts and different schemas. Left unset, the turn contract is used, so
   * every existing caller is unaffected.
   */
  system?: string
  schema?: { name: string; schema: unknown }
}

/** Injectable so the handler can be tested without a live model. */
export type Provider = (req: ProviderRequest, signal: AbortSignal) => Promise<unknown>


/** Waits, unless the caller gives up first. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new ProviderError('aborted while waiting to retry', 'timeout'))
      },
      { once: true },
    )
  })
}

/**
 * A genuine rate limit is worth waiting out once, briefly. Quota exhaustion, a
 * rejected key and a refused request are all permanent — retrying those just
 * burns the request budget and delays telling the user the truth.
 */
const RETRYABLE_WAIT_CEILING_MS = 4000

/** Wraps any provider implementation with that policy. */
export function withRetry(attempt: Provider): Provider {
  return async (req, signal) => {
    try {
      return await attempt(req, signal)
    } catch (err) {
      // A cancelled or timed-out call is never retried: nobody is waiting,
      // and there is no budget left inside the server's own deadline.
      if (err instanceof ProviderError && err.kind === 'rate_limited' && !signal.aborted) {
        const waitMs = Math.round((err.retryAfter ?? 1) * 1000)
        if (waitMs <= RETRYABLE_WAIT_CEILING_MS) {
          console.warn(`[lock] rate limited; retrying once in ${waitMs}ms`)
          await pause(waitMs, signal)
          return attempt(req, signal)
        }
        console.warn(`[lock] rate limited; provider asked for ${err.retryAfter}s — not waiting`)
      }
      throw err
    }
  }
}
