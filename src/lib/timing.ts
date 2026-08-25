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
  draw: 340,
  /** 4 — a single settling beat. */
  settle: 140,
  /** How long the message takes to fade in. It is only fully readable after. */
  messageFade: 220,
  /**
   * 5 — the message. Sized so that `message - messageFade` leaves a genuinely
   * readable window at full opacity, not just time spent fading in.
   */
  message: 680,
  /** 6 — out. */
  exit: 200,
} as const

export const CONFIRM_REDUCED = {
  hold: 80,
  resolve: 60,
  draw: 1,
  settle: 40,
  messageFade: 80,
  message: 520,
  exit: 100,
} as const

export type ConfirmTiming = typeof CONFIRM

/**
 * The designed length of the sequence, from release to the overlay leaving.
 *
 * `resolve` is not added: the capsule resolving and the overlay fading in
 * happen while the checkmark is already drawing, so it overlaps rather than
 * extends. Real wall time can exceed this when the turn has not landed yet —
 * the confirmation waits rather than cutting itself short.
 */
export const confirmTotal = (t: ConfirmTiming | typeof CONFIRM_REDUCED) =>
  t.hold + t.draw + t.settle + t.message + t.exit

/** How long the message is legible at full opacity. */
export const messageDwell = (t: ConfirmTiming | typeof CONFIRM_REDUCED) =>
  t.message - t.messageFade + t.exit
