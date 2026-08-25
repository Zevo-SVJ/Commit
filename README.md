# Lock

A decision instrument. You bring something you are unsure about; Lock finds the
decision inside it, strips away what does not matter, and puts that decision in
front of you to commit to.

**Understand → clarify → decide → slide → move forward.**

It is a web app. Not a chatbot, and not a native app.

---

## Running it

Lock needs one secret. It is read on the server only.

```bash
cp .env.example .env      # add your OPENAI_API_KEY
npm install
npm run dev               # http://localhost:5173 — API included
```

`npm run dev` mounts `/api/decision` inside Vite, so local development is one
command and exercises the same handler that runs in production.

```bash
npm run build && npm start   # self-hosted: client + API on one port
npm run typecheck
npm test                     # server, provider and validation tests
```

Without a key the app loads and tells you plainly that no model is connected.
It does not fall back to canned responses.

## Deploying

The model call must stay server-side, so **static hosting will not work** —
this is why the old GitHub Pages deploy is gone. Any host that runs Node will
do.

- **Vercel** — zero config. Import this repo at
  [vercel.com/new](https://vercel.com/new/import?s=https%3A%2F%2Fgithub.com%2FZevo-SVJ%2FCommit),
  set `OPENAI_API_KEY` when prompted, deploy. `vercel.json` and
  `api/decision.ts` are already in place, and every later push redeploys.
- **Anything else** — `npm run build && npm start` serves the client and the
  API together on `PORT` (default 3000).

| Variable | Required | Notes |
| --- | --- | --- |
| `OPENAI_API_KEY` | yes | Server-side only. CI fails the build if a key or its name reaches the client bundle. |
| `LOCK_MODEL` | no | Defaults to `gpt-4.1`. |
| `OPENAI_BASE_URL` | no | For a gateway or regional endpoint. |

## If a deployment is not working

Open the diagnostic. On a deployment it is:

```
https://<your-deployment>/probe          ← runs the live probe
https://<your-deployment>/health         ← no provider call, costs nothing
```

Both are short forms of `/api/health`, which is the real path. Opening
`/api/decision` in a browser hands over to the same page rather than answering
405. In a browser you get a readable page; anything else gets JSON, and
`?format=json` forces JSON either way.

It reports whether a key reached the runtime, its length and prefix (never the
key), whether it has stray whitespace, the model, the Node version, and the
commit that is live. If `/api/health` answers and `/api/decision` does not, the
fault is in the decision function's module graph rather than in routing.

**Environment variables only apply to deployments made after they were added.**
Adding `OPENAI_API_KEY` to an existing project does nothing until you redeploy —
`key.present: false` on a live `/api/health` is that, almost every time.

The error screen carries a Details line naming where the request broke: the
status, whether a web page came back instead of JSON, and the failing stage. It
contains no key and no journey content.

Add `?probe=1` and it also asks the provider two questions — is this key
accepted, and does this account have credit — reporting the answers as a
verdict with advice. It costs a handful of tokens and never reports the key.

| What you see | What it means |
| --- | --- |
| `not_found` · HTTP 404 | `/api/decision` is not deployed |
| `unreachable` · HTTP 5xx + web page | the function crashed before answering |
| `server_boot` | the function ran but could not load its own modules |
| `unconfigured` | no key reached the runtime — redeploy after adding it |
| `auth` | a key was sent and the provider rejected it |
| `quota` | HTTP 429 because the account has no credit. **Waiting will not help** — add credit |
| `rate_limited` | HTTP 429 from a real per-minute limit. This one does clear |
| `model_unavailable` | the account cannot use `LOCK_MODEL` |
| `model_request_rejected` | the provider refused the request itself |
| `upstream` | the provider failed; the reason is in the function logs |
| `invalid_response` | the model answered, but not with a usable turn |
| `timeout` | no reply within 25s |
| `offline` | the request never left the browser |

A provider 429 is two different faults wearing one status code. `quota` means
billing; `rate_limited` means slow down. Only the second is retried, once, and
only when the provider asks for a wait of four seconds or less.

Function logs: Vercel → your project → **Logs**, filter to `/api/decision`.
Lines are prefixed `[lock]`.

## Architecture

```
src/           the client. Renders what the server sends; never calls a model.
  lib/api.ts        the only network call
  lib/useJourney.ts all state logic
  components/       presentation only
shared/types.ts  the contract both sides import
server/
  handler.ts     host-agnostic core — every adapter calls exactly this
  ai/prompt.ts   Lock's system prompt
  ai/schema.ts   the structured-output schema, and the validator we actually trust
  ai/provider.ts the OpenAI Responses API, over plain fetch
api/decision.ts  Vercel adapter
```

Three hosts, one implementation: the Vite dev middleware, the Vercel function,
and the standalone Node server all call `handleTurn`.

### Why it does not behave like a chatbot

Two things enforce it. The prompt forbids restating the user's own words, and
the response schema has **no field whose only content is commentary** — every
line Lock says rides along with a question or a decision. If it has nothing to
add, `framing` is null and nothing renders. Silence is the default.

Underneath that, `understanding` is rewritten from scratch on every turn rather
than appended to, so the journey compresses as it goes instead of accumulating
a transcript. A question is only allowed through validation if the model can
name what a different answer would change.

Compression has a failure mode — a rewritten note can drop something the user
actually said — so `journey.exchanges` keeps every question asked and its exact
answer, verbatim and capped. The brief lists them and forbids re-asking any of
them, and tells the model to trust the verbatim answer over its own notes if
the two disagree.

### What the server refuses to trust

The model is constrained by a strict JSON schema, but structured output can
still be degraded by a proxy or a refusal, so nothing reaches the client until
it has passed `parseTurn`. Acknowledgement and restatement phrasing is stripped
there as a net under the prompt. Confirmations are recorded by the server from
the user's gesture, never from the model echoing them back — sliding is ground
truth.

## The slide

`SlideToConfirm` is direct manipulation: the thumb is pointer-captured and
follows the finger continuously, both directions, at any speed. A decision is
confirmed only when the thumb reaches the end of the track **and** the gesture
is released there. Tapping the capsule, tapping the thumb, releasing short, or
reversing all leave the decision unmade.

Keyboard users get the same control (`role="slider"`, arrow keys, `Enter` at the
end) plus a visually secondary fallback.

The confirmation runs ~1.7s across six phases — hold, resolve, the checkmark
drawn rather than revealed, one settling ring, the message, then the
transition. `src/lib/timing.ts` holds every number.

## Mobile browsers

Built to sit inside real Safari and Chrome rather than to simulate them.
`src/lib/useAppViewport.ts` measures `visualViewport` into `--app-h`,
`--app-top` and `--kb-h`, with `dvh` as the pre-JS baseline. The document never
scrolls — screens scroll internally — so the slide keeps clear of the toolbar
whether it is expanded, collapsing on scroll, or replaced by the keyboard.

Verified in Chromium at 390×844, 393×852, 430×932, both landscape orientations,
and desktop — including rotation mid-journey, the keyboard opening and closing,
and the toolbar expanding and collapsing.

WebKit is not installed in the environment this was built in, so iOS Safari
itself has not been exercised. Chromium with `visualViewport` emulation is the
closest available proxy.

### Disagreeing

`understanding.contradiction` is the one place Lock pushes back. It is surfaced
to the user on the turn it first appears and not repeated afterwards, and it is
styled apart from ordinary framing so it does not read as commentary.

## Known gaps

- **The model's behaviour is unverified against a live model.** There was no API
  key available while building. The structural guards against chatbot behaviour
  are tested; the prompt's judgement is not.
- **No streaming.** A turn is a small structured object, not prose, so there is
  nothing to stream progressively — the loading state covers the wait instead.
- **No database.** `shared/types.ts` is shaped for one, and journeys persist in
  `sessionStorage` for the current sitting.
