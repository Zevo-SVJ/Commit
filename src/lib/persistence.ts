import type { DecisionJourney, Step } from '../../shared/types.ts'

/**
 * A journey survives a reload, a rotation, and an accidental back-swipe.
 *
 * sessionStorage rather than localStorage: an unfinished decision belongs to
 * the sitting you are in, not to the device forever. Every access is guarded —
 * private mode and blocked site data both throw here.
 */

const KEY = 'lock.journey.v1'

export interface Saved {
  journey: DecisionJourney
  step: Step
}

export function save(state: Saved | null) {
  try {
    if (!state) sessionStorage.removeItem(KEY)
    else sessionStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* storage unavailable — the journey simply will not survive a reload */
  }
}

export function load(): Saved | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Saved
    if (!parsed?.journey?.id || !parsed?.step?.kind) return null
    return parsed
  } catch {
    return null
  }
}
