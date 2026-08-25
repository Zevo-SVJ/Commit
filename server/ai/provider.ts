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

export interface ProviderRequest {
  /** The conversation so far, already compressed into a compact brief. */
  brief: string
  instruction: string
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
