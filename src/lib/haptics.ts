/**
 * Best-effort tactile feedback.
 *
 * iOS Safari does not expose the Vibration API, so on the primary target
 * device this is a no-op by design — the interaction has to feel physical
 * without it. Where vibration exists (Android Chrome), it reinforces the
 * two moments that matter: reaching the end of the track, and committing.
 */
type Pattern = 'edge' | 'commit' | 'reset'

const PATTERNS: Record<Pattern, number | number[]> = {
  edge: 8,
  commit: [12, 40, 22],
  reset: 5,
}

export function haptic(pattern: Pattern) {
  try {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate(PATTERNS[pattern])
    }
  } catch {
    /* never let feedback break the interaction */
  }
}
