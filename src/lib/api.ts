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
}

export class LockRequestError extends Error {
  code: ApiErrorCode
  retryable: boolean

  constructor(e: LockError) {
    super(e.message)
    this.name = 'LockRequestError'
    this.code = e.code
    this.retryable = e.retryable
  }
}

const TIMEOUT_MS = 35_000

const NETWORK_ERROR: LockError = {
  code: 'upstream',
  message: 'No connection.',
  retryable: true,
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
        ? { code: 'timeout', message: 'That took too long.', retryable: true }
        : NETWORK_ERROR,
    )
  } finally {
    window.clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }

  let payload: unknown
  try {
    payload = await res.json()
  } catch {
    throw new LockRequestError({
      code: 'invalid_response',
      message: 'That did not come back cleanly.',
      retryable: true,
    })
  }

  if (!res.ok) {
    const e = (payload as ApiError)?.error
    throw new LockRequestError(
      e?.message
        ? e
        : { code: 'upstream', message: 'Something went wrong.', retryable: true },
    )
  }

  const turn = payload as TurnResponse
  // The server validates the model; the client validates the server.
  if (!turn?.journey?.id || !turn?.step?.kind) {
    throw new LockRequestError({
      code: 'invalid_response',
      message: 'That did not come back cleanly.',
      retryable: true,
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
      err.code === 'upstream' &&
      err.message === NETWORK_ERROR.message
    ) {
      return once(journey, event, signal)
    }
    throw err
  }
}
