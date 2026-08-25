import { SYSTEM_PROMPT } from './prompt.js'
import { TURN_JSON_SCHEMA } from './schema.js'

/**
 * The OpenAI Responses API, called directly over fetch.
 *
 * No SDK: this is one POST with a JSON body, and avoiding the dependency keeps
 * the serverless bundle small and the failure modes visible.
 */

export type ProviderErrorKind = 'unconfigured' | 'rate_limited' | 'timeout' | 'upstream'

export class ProviderError extends Error {
  // Plain fields rather than constructor parameter properties, so these files
  // run under Node's type-stripping without a build step.
  kind: ProviderErrorKind
  status: number | undefined

  constructor(message: string, kind: ProviderErrorKind, status?: number) {
    super(message)
    this.name = 'ProviderError'
    this.kind = kind
    this.status = status
  }
}

export interface ProviderRequest {
  /** The conversation so far, already compressed into a compact brief. */
  brief: string
  instruction: string
}

/** Injectable so the handler can be tested without a live model. */
export type Provider = (req: ProviderRequest, signal: AbortSignal) => Promise<unknown>

const DEFAULT_MODEL = 'gpt-4.1'
const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

export function createOpenAIProvider(env: NodeJS.ProcessEnv = process.env): Provider {
  return async (req, signal) => {
    const key = env.OPENAI_API_KEY
    if (!key) {
      throw new ProviderError('OPENAI_API_KEY is not set', 'unconfigured')
    }

    let res: Response
    try {
      const base = (env.OPENAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '')
      res = await fetch(`${base}/responses`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: env.LOCK_MODEL || DEFAULT_MODEL,
          instructions: SYSTEM_PROMPT,
          input: [{ role: 'user', content: `${req.brief}\n\n${req.instruction}` }],
          // Deliberately low: Lock should be consistent, not creative.
          temperature: 0.35,
          // The schema is large; too low a cap truncates the JSON mid-object
          // and the turn is discarded as unparseable.
          max_output_tokens: 1600,
          text: {
            format: {
              type: 'json_schema',
              name: 'lock_turn',
              strict: true,
              schema: TURN_JSON_SCHEMA,
            },
          },
        }),
      })
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        throw new ProviderError('model call timed out', 'timeout')
      }
      throw new ProviderError('could not reach the model', 'upstream')
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      if (res.status === 429) throw new ProviderError('rate limited', 'rate_limited', 429)
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError('model rejected the credentials', 'unconfigured', res.status)
      }
      // Body is logged server-side only; it never reaches the client. The
      // provider's own message is the fastest way to spot a rejected schema
      // or an unknown model name.
      throw new ProviderError(
        `model returned ${res.status}: ${body.slice(0, 500)}`,
        'upstream',
        res.status,
      )
    }

    const payload = (await res.json()) as Record<string, unknown>

    // A run cut short by the token cap yields valid-looking but partial JSON.
    if (payload.status === 'incomplete') {
      const reason = (payload.incomplete_details as { reason?: string } | undefined)?.reason
      throw new ProviderError(`model stopped early (${reason ?? 'unknown'})`, 'upstream')
    }
    return extractJson(payload)
  }
}

/**
 * Pulls the structured object out of a Responses API payload.
 *
 * `output_text` is the documented convenience field, but it is not always
 * present depending on the shape of the response, so the nested output array is
 * walked as a fallback.
 */
export function extractJson(payload: Record<string, unknown>): unknown {
  const direct = payload.output_text
  if (typeof direct === 'string' && direct.trim()) return safeParse(direct)

  const output = payload.output
  if (Array.isArray(output)) {
    for (const item of output) {
      const content = (item as Record<string, unknown>)?.content
      if (!Array.isArray(content)) continue
      for (const part of content) {
        const p = part as Record<string, unknown>
        if (typeof p?.text === 'string' && p.text.trim()) return safeParse(p.text)
        // Some gateways return the already-parsed object.
        if (p?.type === 'output_json' && p.json) return p.json
      }
    }
  }
  throw new ProviderError('model returned an empty response', 'upstream')
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // A refusal or a truncated stream lands here.
    throw new ProviderError('model returned unparseable output', 'upstream')
  }
}
