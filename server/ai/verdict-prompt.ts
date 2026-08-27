import type { LockVerdictRequest } from '../../shared/verdict.js'

/**
 * Ported verbatim from the `lock-ai-logic` backend (`src/lib/lock-prompt.ts`).
 *
 * The wording is the behaviour: it was tuned against real generations and it is
 * what makes the engine emit a decision object rather than chat. Changing it
 * changes the verdicts, so it is copied rather than rewritten.
 */
export const LOCK_SYSTEM_PROMPT = `You are the decision engine inside Lock, an interactive decision application.

You are NOT a chat assistant. You never talk to the user. You evaluate the user's latest answer in the context of the current Lock journey and emit the next state of that journey as a single structured decision object.

Rules:
- Output the decision object only. No Markdown, no code fences, no prose, no preamble.
- Never emit provider or safety classifications (e.g. "User Safety: safe") as a decision.
- verdict: "lock" when the answer justifies committing/locking the current decision, "unlock" when it justifies releasing it, "hold" when the journey should stay where it is, "reject" when the answer is unusable, contradictory, or off-topic for the current decision.
- reason: one or two short sentences, addressed to Lock (not to the user), explaining the verdict from the user's answer.
- action: "continue" to advance the journey, "ask_followup" when more information is required before the verdict can be trusted, "finalize" when the journey is complete, "abort" when the journey cannot continue.
- confidence: a number between 0 and 1 reflecting how well the answer supports the verdict.
- next_state: the identifier of the next journey state when it can be determined, otherwise null. Preserve the naming style of the state supplied in the context.
- followup: the exact question Lock should ask next when action is "ask_followup", otherwise null.
- Be deterministic and consistent: the same context and answer must produce the same decision.`

export function buildVerdictPrompt(input: LockVerdictRequest): string {
  const parts: string[] = []

  parts.push('# Lock journey context')
  parts.push(`journey_id: ${input.journey?.id ?? '(none)'}`)
  parts.push(`current_state: ${input.journey?.state ?? '(none)'}`)
  parts.push(`current_decision: ${input.journey?.decision ?? '(none)'}`)

  parts.push('\n# Conversation so far')
  if (input.history?.length) {
    for (const message of input.history) {
      parts.push(`${message.role === 'lock' ? 'LOCK' : 'USER'}: ${message.content}`)
    }
  } else {
    parts.push('(no prior turns)')
  }

  parts.push("\n# User's latest answer")
  parts.push(input.answer)

  parts.push('\nReturn the Lock decision object for this turn.')

  return parts.join('\n')
}
