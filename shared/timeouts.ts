/**
 * The timeout ladder, in one place.
 *
 * These three values are a single policy, not three settings. They were
 * scattered across `server/handler.ts`, `src/lib/api.ts` and `vercel.json`,
 * which is how they drifted into a shape where the platform could kill a
 * function before the server had a chance to answer.
 *
 * The order is deliberate and enforced by a test:
 *
 *   PROVIDER_TIMEOUT_MS  <  FUNCTION_MAX_DURATION  <  CLIENT_TIMEOUT_MS
 *
 * The server must give up first, so that a slow model produces a clean,
 * classified `timeout` rather than the platform tearing the function down
 * mid-flight and leaving the browser to guess from an HTML error page.
 *
 * The client must give up *last*, so that whatever the server decided is the
 * thing the user is told. A client that times out first throws away the
 * server's classification and replaces it with a guess — and leaves a paid
 * generation running with nobody to receive it.
 */

/**
 * What `vercel.json` grants each function. 60s is the ceiling for Node
 * functions on Vercel's Hobby plan, so this is the most room available
 * without changing plan.
 */
export const FUNCTION_MAX_DURATION_S = 60

/**
 * When the server stops waiting on the provider.
 *
 * Sized for `openrouter/free`, which routes to free models that queue behind
 * other free traffic — a structured generation of this size is routinely
 * slower there than on a paid endpoint, and the previous 25s was inside the
 * range where a normal response arrives. 45s leaves 15s of headroom for the
 * function to serialise its answer and return it before the platform's limit.
 */
export const PROVIDER_TIMEOUT_MS = 45_000

/**
 * When the browser stops waiting on the function.
 *
 * Past the platform limit on purpose: if the function is killed at 60s, the
 * browser is still listening and reports what actually came back instead of
 * inventing a timeout of its own.
 */
export const CLIENT_TIMEOUT_MS = 65_000

/** True when the ladder holds. Asserted by the test suite and by the build. */
export function ladderIsSound(
  provider = PROVIDER_TIMEOUT_MS,
  platformSeconds = FUNCTION_MAX_DURATION_S,
  client = CLIENT_TIMEOUT_MS,
): boolean {
  return provider < platformSeconds * 1000 && platformSeconds * 1000 < client
}
