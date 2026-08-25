/**
 * The confirmation sequence, in one place.
 *
 * Release to overlay gone is ~1.4s: long enough to watch the check draw and
 * read the line, short enough that a three-decision journey never feels like
 * waiting. The phases are separated so each is actually perceived rather than
 * blurring into one fade.
 */
export const CONFIRM = {
  /** 1 — the slider sits completed under the finger before anything moves. */
  hold: 240,
  /** 2 — the capsule resolves; the overlay takes over. */
  resolve: 200,
  /** 3 — the checkmark is drawn, not revealed. */
  draw: 360,
  /** 4 — a single settling beat. */
  settle: 140,
  /** 5 — the message, held long enough to read. */
  message: 560,
  /** 6 — out. */
  exit: 200,
} as const

export const CONFIRM_REDUCED = {
  hold: 80,
  resolve: 60,
  draw: 1,
  settle: 40,
  message: 420,
  exit: 100,
} as const

export type ConfirmTiming = typeof CONFIRM

/** Total wall time from release to the next step appearing. */
export const confirmTotal = (t: ConfirmTiming | typeof CONFIRM_REDUCED) =>
  t.hold + t.resolve + t.draw + t.settle + t.message + t.exit
