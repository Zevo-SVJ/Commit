# Commit

A high-fidelity interactive prototype of a decision interface.

**Think → Decide → Commit → Move forward.**

This is a product prototype and interaction lab, not the production SaaS. It runs
entirely on local, deterministic mock logic: no API keys, no backend, no auth.

## Try it on a phone

The prototype deploys to GitHub Pages on every push to this branch:

**https://zevo-svj.github.io/Commit/**

Open that in Safari or Chrome on a phone. It is a normal website, so the
browser's own toolbars behave normally — which is the point.

## Run it locally

```bash
npm install
npm run dev      # then open the printed network URL on your phone
```

`npm run dev` binds to `0.0.0.0`, so the printed network address opens directly
on a phone on the same network — which is how this should be evaluated.

```bash
npm run build && npm run preview   # production build
npm run typecheck
```

## What to try

- **Simple** demo — one decision resolves the whole journey.
- **Complex** demo — three decisions, including a point where new information
  makes the journey *less* resolved than it was.
- Type your own decision ("Should I…") — the journey adapts, and grows a second
  decision only if you say the decision is hard to undo.
- **Not sure yet?** — describe a situation and name the decision hiding in it.
- **+** in the top bar, at any point — add a decision of your own. It goes next,
  and it outranks anything the system assumed was left.

## The slide

`SlideToConfirm` is the signature interaction and the thing to judge first. It is
true direct manipulation: the thumb is captured by the pointer and follows it
continuously, forward and backward, at any speed. A decision is confirmed only
when the thumb actually reaches the end of the track *and* the gesture is
released there. Tapping the capsule, tapping the thumb, or releasing short of the
end all leave the decision unmade and spring the thumb home.

Keyboard users get the same control (`role="slider"`, arrow keys, `Enter` at the
end), plus a visually secondary "Can't slide?" fallback.

## Mobile browser behaviour

The site is built to sit correctly inside real Safari and Chrome chrome rather
than to simulate it. `src/lib/useAppViewport.ts` measures `visualViewport` and
publishes `--app-h`, `--app-top` and `--kb-h`; CSS carries `dvh` as the pre-JS
baseline. The document never scrolls — screens scroll internally — so
bottom-anchored controls stay clear of the toolbar whether it is expanded,
collapsing during scroll, or replaced by the keyboard.

## Structure

```
src/
  lib/
    types.ts           # DecisionJourney / Decision / Beat — the internal model
    scenarios.ts       # the two authored demos
    engine.ts          # phrasing, adaptive journeys, finality resolution
    useJourney.ts      # the reducer: all state logic, no presentation
    useAppViewport.ts  # live viewport + keyboard measurement
  components/          # presentation only
  styles/              # the visual system
```

State logic is separate from presentation, and the mock intelligence is confined
to `engine.ts` and `scenarios.ts` — that is where a real model would plug in.
Nothing else knows the intelligence is fake.
