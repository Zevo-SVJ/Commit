# LOCK

A decision instrument. You bring something you are unsure about; LOCK finds the
decision inside it, strips away what does not matter, and puts that decision in
front of you to commit to.

**Understand → clarify → decide → slide → move forward.**

It is a web app. Not a chatbot, and not a native app.

---

## Running it

LOCK needs one secret. It is read on the server only.

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

- **Vercel** — zero config. `vercel.json` is already here, `api/decision.ts` is
  the function. Set `OPENAI_API_KEY` in the project's environment variables.
- **Anything else** — `npm run build && npm start` serves the client and the
  API together on `PORT` (default 3000).

| Variable | Required | Notes |
| --- | --- | --- |
| `OPENAI_API_KEY` | yes | Server-side only. CI fails the build if a key or its name reaches the client bundle. |
| `LOCK_MODEL` | no | Defaults to `gpt-4.1`. |
| `OPENAI_BASE_URL` | no | For a gateway or regional endpoint. |

## Architecture

```
src/           the client. Renders what the server sends; never calls a model.
  lib/api.ts        the only network call
  lib/useJourney.ts all state logic
  components/       presentation only
shared/types.ts  the contract both sides import
server/
  handler.ts     host-agnostic core — every adapter calls exactly this
  ai/prompt.ts   LOCK's system prompt
  ai/schema.ts   the structured-output schema, and the validator we actually trust
  ai/provider.ts the OpenAI Responses API, over plain fetch
api/decision.ts  Vercel adapter
```

Three hosts, one implementation: the Vite dev middleware, the Vercel function,
and the standalone Node server all call `handleTurn`.

### Why it does not behave like a chatbot

Two things enforce it. The prompt forbids restating the user's own words, and
the response schema has **no field whose only content is commentary** — every
line LOCK says rides along with a question or a decision. If it has nothing to
add, `framing` is null and nothing renders. Silence is the default.

Underneath that, `understanding` is rewritten from scratch on every turn rather
than appended to, so the journey compresses as it goes instead of accumulating
a transcript. A question is only allowed through validation if the model can
name what a different answer would change.

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

## Known gaps

- **The model's behaviour is unverified against a live model.** There was no API
  key available while building. The structural guards against chatbot behaviour
  are tested; the prompt's judgement is not.
- **No streaming.** A turn is a small structured object, not prose, so there is
  nothing to stream progressively — the loading state covers the wait instead.
- **No database.** `shared/types.ts` is shaped for one, and journeys persist in
  `sessionStorage` for the current sitting.
