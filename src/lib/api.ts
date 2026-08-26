import type {
  ApiError,
  ApiErrorCode,
  DecisionJourney,
  TurnEvent,
  TurnResponse,
} from '../../shared/types.ts'
import { CLIENT_TIMEOUT_MS } from '../../shared/timeouts.ts'

/**
 * The only place the client talks to the server. Nothing here knows about a
 * model, and no secret ever reaches this file — the key lives on the server.
 */

export interface LockError {
  code: ApiErrorCode
  message: string
  retryable: boolean
  /**
   * Where the failure actually happened, in one line. Contains no secret and
   * no journey content — only status codes and error classes — so it is safe
   * to show in production, which is the only place these faults appear.
   */
  diagnostic?: string
}

export class LockRequestError extends Error {
  code: ApiErrorCode
  retryable: boolean
  diagnostic?: string

  constructor(e: LockError) {
    super(e.message)
    this.name = 'LockRequestError'
    this.code = e.code
    this.retryable = e.retryable
    this.diagnostic = e.diagnostic
  }
}

/** The browser's share of the ladder. See shared/timeouts.ts. */
const TIMEOUT_MS = CLIENT_TIMEOUT_MS

const NETWORK_ERROR: LockError = {
  code: 'offline',
  message: 'No connection.',
  retryable: true,
  diagnostic: 'the request never left the browser',
}

/** Thrown when *we* cancelled — a newer turn, a reset, an unmount. */
export const CANCELLED = new DOMException('cancelled', 'AbortError')

const isAbort = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'

async function once(
  journey: DecisionJourney | null,
  event: TurnEvent,
  signal?: AbortSignal,
): Promise<TurnResponse> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS)
  // Let a caller-supplied signal (a newer turn, a reset, unmount) abort us too.
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort)

  /*
   * One try around the fetch *and* the body read.
   *
   * The cleanup used to run the moment the headers arrived, which left the
   * body read with no timeout at all and no way to be cancelled — a server
   * that answered and then stalled mid-body hung the browser indefinitely,
   * and an abort landing there was swallowed into "empty body" and reported
   * as `unreachable`.
   */
  try {
    let res: Response
    try {
      res = await fetch('/api/decision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ journey, event }),
        signal: controller.signal,
      })
    } catch (err) {
      throw transportFailure(err, signal, controller)
    }

    // Read the status BEFORE the body. Parsing first meant any non-JSON reply —
    // a platform 404 page, an HTML crash page, the SPA fallback — collapsed into
    // one "did not come back cleanly", discarding the status that identified it.
    const contentType = res.headers.get('content-type') ?? ''
    let raw: string
    try {
      raw = await res.text()
    } catch (err) {
      // An abort here is a cancellation or a timeout, not a mystery.
      throw transportFailure(err, signal, controller, 'while reading the reply')
    }

    let payload: unknown = null
    let parsed = false
    if (raw) {
      try {
        payload = JSON.parse(raw)
        parsed = true
      } catch {
        parsed = false
      }
    }

    // A non-JSON body means the request never reached our handler: the handler
    // answers with JSON on every path, including its own failures.
    if (!parsed) {
      const html = /^\s*<(!doctype|html)/i.test(raw)
      throw new LockRequestError({
        code: res.status === 404 ? 'not_found' : res.status === 504 ? 'timeout' : 'unreachable',
        message: res.status === 504 ? 'That took too long.' : 'Lock could not reach its own service.',
        retryable: true,
        diagnostic: [
          `HTTP ${res.status}`,
          html ? 'received a web page instead of a response' : `content-type: ${contentType || 'none'}`,
          res.status === 404
            ? '/api/decision is not deployed'
            : res.status === 405
              ? 'the endpoint rejected POST'
              : res.status === 504
                ? 'the platform stopped the function before it answered'
                : res.status >= 500
                  ? 'the function failed to run'
                  : 'unexpected reply',
          raw ? `body starts: ${raw.slice(0, 80).replace(/\s+/g, ' ')}` : 'empty body',
        ].join(' · '),
      })
    }

    if (!res.ok) {
      const e = (payload as ApiError)?.error
      throw new LockRequestError({
        code: e?.code ?? 'upstream',
        message: e?.message ?? 'Something went wrong.',
        retryable: e?.retryable ?? true,
        diagnostic: [`HTTP ${res.status}`, e?.code, (e as { detail?: string })?.detail]
          .filter(Boolean)
          .join(' · '),
      })
    }

    const turn = payload as TurnResponse
    // The server validates the model; the client validates the server.
    if (!turn?.journey?.id || !turn?.step?.kind) {
      throw new LockRequestError({
        code: 'invalid_response',
        message: 'That did not come back cleanly.',
        retryable: true,
        diagnostic: `HTTP ${res.status} · JSON was valid but not a turn · keys: ${Object.keys(
          (payload as object) ?? {},
        )
          .slice(0, 6)
          .join(',')}`,
      })
    }
    return turn
  } finally {
    window.clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Names who ended the request.
 *
 * A bare AbortError says nothing about whose decision it was. Ours is a
 * timeout the user should be told about; the caller's is a cancellation that
 * must stay silent, because something newer is already on screen.
 */
function transportFailure(
  err: unknown,
  caller: AbortSignal | undefined,
  ours: AbortController,
  where = '',
): Error {
  if (caller?.aborted) return CANCELLED
  if (isAbort(err) || ours.signal.aborted) {
    return new LockRequestError({
      code: 'timeout',
      message: 'That took too long.',
      retryable: true,
      diagnostic: [`no reply within ${Math.round(TIMEOUT_MS / 1000)}s`, where]
        .filter(Boolean)
        .join(' '),
    })
  }
  return new LockRequestError(NETWORK_ERROR)
}

/**
 * One request per turn. No automatic retry, deliberately.
 *
 * The old transparent retry fired whenever `fetch` rejected — but from the
 * browser there is no way to tell a request that never left from one that was
 * fully processed and then lost its connection on the way back. Retrying the
 * second case runs the generation a second time: a duplicated user action, and
 * a second draw on a free-tier allowance, for one tap.
 *
 * So a transport failure is reported as retryable and the user decides. The
 * journey is never lost, and pressing retry replays the same event.
 */
export async function takeTurn(
  journey: DecisionJourney | null,
  event: TurnEvent,
  signal?: AbortSignal,
): Promise<TurnResponse> {
  return once(journey, event, signal)
}
