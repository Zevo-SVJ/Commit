/**
 * The diagnostic, at a path that cannot be rewritten away.
 *
 * `/probe` is a rewrite in vercel.json, and a rewrite is only as reliable as
 * the platform's routing order — a deployment reported `/probe` as missing
 * while the function behind it answered perfectly well. A real file under
 * /api needs no routing rule at all, and `/api/probe` turns the probe on by
 * itself: the handler already treats a path ending in `probe` as the flag.
 */
export { default } from './health.js'
