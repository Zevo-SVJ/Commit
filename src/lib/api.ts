import type {
  ApiError,
  ApiErrorCode,
  DecisionJourney,
  TurnEvent,
  TurnResponse,
} from '../../shared/types.ts'

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

const TIMEOUT_MS = 35_000

const NETWORK_ERROR: LockError = {
  code: 'offline',
  message: 'No connection.',
  retryable: true,
  diagnostic: 'the request never left the browser',
}

async function once(
  journey: DecisionJourney | null,
  event: TurnEvent,
  signal?: AbortSignal,
): Promise<TurnResponse> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS)
  // Let a caller-supplied signal (unmount, user cancel) abort us too.
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort)

  let res: Response
  try {
    res = await fetch('/api/decision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ journey, event }),
      signal: controller.signal,
    })
  } catch {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    throw new LockRequestError(
      controller.signal.aborted
        ? {
            code: 'timeout',
            message: 'That took too long.',
            retryable: true,
            diagnostic: `no reply within ${TIMEOUT_MS / 1000}s`,
          }
        : NETWORK_ERROR,
    )
  } finally {
    window.clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }

  // Read the status BEFORE the body. Parsing first meant any non-JSON reply —
  // a platform 404 page, an HTML crash page, the SPA fallback — collapsed into
  // one "did not come back cleanly", discarding the status that identified it.
  const contentType = res.headers.get('content-type') ?? ''
  const raw = await res.text().catch(() => '')

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
      code: res.status === 404 ? 'not_found' : 'unreachable',
      message: 'Lock could not reach its own service.',
      retryable: true,
      diagnostic: [
        `HTTP ${res.status}`,
        html ? 'received a web page instead of a response' : `content-type: ${contentType || 'none'}`,
        res.status === 404
          ? '/api/decision is not deployed'
          : res.status === 405
            ? 'the endpoint rejected POST'
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
}

/**
 * One transparent retry, and only for transport failures — a dropped
 * connection is worth re-trying instantly, a rate limit or a timeout is not.
 */
export async function takeTurn(
  journey: DecisionJourney | null,
  event: TurnEvent,
  signal?: AbortSignal,
): Promise<TurnResponse> {
  try {
    return await once(journey, event, signal)
  } catch (err) {
    if (
      err instanceof LockRequestError &&
      err.code === 'offline' &&
      err.message === NETWORK_ERROR.message
    ) {
      return once(journey, event, signal)
    }
    throw err
  }
}
