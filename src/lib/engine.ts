import { buildCatScenario, buildPartnershipScenario, uid } from './scenarios'
import type {
  Beat,
  Decision,
  DecisionJourney,
  Scenario,
} from './types'

/* ------------------------------------------------------------------ */
/* Language                                                            */
/* ------------------------------------------------------------------ */

const sentenceCase = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)
const stripEnd = (s: string) => s.replace(/[\s.?!]+$/, '')

/**
 * Turn whatever the user typed into the two forms we need: the decision as a
 * question, and the commitment as a statement they can slide on.
 *
 * A real intelligence layer replaces this function and nothing else.
 */
export function phraseFromInput(raw: string): { question: string; commitment: string } {
  const text = stripEnd(raw.trim())
  if (!text) return { question: 'What are you deciding?', commitment: 'Move forward.' }

  const lead = text.match(/^(should|shall|do|does|can|could|would|must|will)\s+(i|we)\s+(.*)$/i)
  if (lead) {
    const rest = stripEnd(lead[3])
    return {
      question: `${sentenceCase(text)}?`,
      commitment: sentenceCase(rest) + '.',
    }
  }

  const or = text.match(/^(.*?)\s+or\s+(.*)$/i)
  if (or && text.length < 90) {
    return {
      question: `${sentenceCase(text)}?`,
      commitment: sentenceCase(stripEnd(or[1])) + '.',
    }
  }

  return {
    question: `${sentenceCase(text)}?`,
    commitment: 'Go ahead with this.',
  }
}

/** A short title for the journey — never the user's whole paragraph. */
export function titleFromInput(raw: string): string {
  const text = stripEnd(raw.trim())
  if (!text) return 'Untitled decision'
  const firstSentence = text.split(/(?<=[.?!])\s+/)[0] ?? text
  const base = firstSentence.length <= 64 ? firstSentence : firstSentence.slice(0, 61).trimEnd() + '…'
  return sentenceCase(base)
}

/* ------------------------------------------------------------------ */
/* Generic adaptive scenario                                           */
/* ------------------------------------------------------------------ */

export type EntryMode = 'decision' | 'situation'

function mkDecision(
  p: Pick<Decision, 'id' | 'question' | 'answer' | 'rationale' | 'stage'> & Partial<Decision>,
): Decision {
  return { source: 'system', status: 'proposed', is_final: false, timestamp: null, ...p }
}

/**
 * Builds a journey from arbitrary input. The *number* of decisions is not
 * fixed: it is determined by how the user answers the reversibility question.
 */
export function buildGenericScenario(raw: string, mode: EntryMode): Scenario {
  const { question, commitment } = phraseFromInput(raw)
  const detail = raw.trim().length
  const rich = detail >= 140
  const thin = detail < 40

  const d1 = mkDecision({
    id: 'gen_d1',
    question,
    answer: commitment,
    rationale: 'This is the direction. The rest is detail.',
    stage: 1,
  })
  /** Queued but only reached if the user says this is hard to undo. */
  const d2 = mkDecision({
    id: 'gen_d2',
    question: 'Should I fix the terms before I move?',
    answer: 'Fix the terms first.',
    rationale: 'You said this is not cheaply undone. Then the terms are the decision.',
    stage: 2,
  })

  const jny: DecisionJourney = {
    id: uid('jny'),
    title: titleFromInput(raw),
    original_problem: raw.trim(),
    current_stage: 1,
    decisions: [d1, d2],
    status: 'active',
    internal_progress: rich ? 0.2 : 0.12,
    known_information: rich
      ? ['You gave the situation, not just the headline.']
      : ['The decision, stated plainly.'],
    unknown_information: ['What makes this hard.', 'Whether it can be undone.'],
    critical_unknowns: [],
    next_action: 'Find the part that is actually difficult.',
    needsFinalCheck: false,
  }

  const beats: Beat[] = []

  beats.push({
    id: uid('b'),
    kind: 'context',
    progressTo: rich ? 0.28 : 0.2,
    label: 'What I understand',
    lead:
      mode === 'situation'
        ? 'There is a decision inside this. Let us find it before anything else.'
        : rich
          ? 'You already know what you are deciding. The detail you gave is enough to work with.'
          : 'You already know what you are deciding. That is further than most people get.',
    facts:
      mode === 'situation'
        ? [
            'A situation, not yet a decision.',
            'Something in here has a yes or a no attached to it.',
            'Naming it is most of the work.',
          ]
        : rich
          ? [question, 'You gave enough context that we can skip the interrogation.', 'What is missing is the shape of the difficulty.']
          : [question, 'Very little context — which is fine.', 'I will only ask for what changes the answer.'],
  })

  if (mode === 'situation') {
    beats.push({
      id: uid('b'),
      kind: 'question',
      progressTo: 0.3,
      prompt: 'What is the decision hiding in this?',
      sub: 'Name it as a yes or a no.',
      allowFree: true,
      freePlaceholder: 'e.g. Should I take the offer?',
      freeEffect: {
        progressTo: 0.38,
        clearFinalCheck: true,
        patchDecisionFromAnswer: 'gen_d1',
      },
      options: [
        {
          id: 'whether',
          label: 'Whether to go ahead at all',
          effect: {
            progressTo: 0.36,
            patchDecision: {
              decisionId: 'gen_d1',
              question: 'Should I go ahead with this?',
              answer: 'Go ahead with this.',
              rationale: 'The decision was whether, and you have found the whether.',
            },
          },
        },
        {
          id: 'when',
          label: 'When, not whether',
          effect: {
            progressTo: 0.36,
            patchDecision: {
              decisionId: 'gen_d1',
              question: 'Should I start now rather than later?',
              answer: 'Start now.',
              rationale: 'You are not deciding if. You are deciding to stop waiting.',
            },
          },
        },
        {
          id: 'who',
          label: 'Who I do it with',
          effect: {
            progressTo: 0.36,
            patchDecision: {
              decisionId: 'gen_d1',
              question: 'Should I commit to these people?',
              answer: 'Commit to these people.',
              rationale: 'The work was never the risk. The counterparty was.',
            },
          },
        },
      ],
    })
  }

  beats.push({
    id: uid('b'),
    kind: 'question',
    progressTo: 0.44,
    prompt: 'What makes this hard?',
    sub: 'Pick the closest one.',
    allowFree: true,
    freePlaceholder: 'Say it your way…',
    freeEffect: {
      progressTo: 0.56,
      insert: [
        {
          id: uid('b'),
          kind: 'insight',
          progressTo: 0.6,
          label: 'The read',
          body: 'You wrote that without pausing, which usually means it is the true obstacle rather than the presentable one. Everything after this gets easier.',
        },
      ],
    },
    options: [
      {
        id: 'info',
        label: 'I am missing information',
        effect: {
          progressTo: 0.54,
          unknown: ['Information the user believes is missing.'],
          insert: [
            {
              id: uid('b'),
              kind: 'insight',
              progressTo: 0.58,
              label: 'The read',
              body: 'Missing information is the most common reason to stall and the least common reason a decision actually goes wrong. Ask what you would do differently if you had it — if the answer is nothing, you already have enough.',
            },
          ],
        },
      },
      {
        id: 'cost',
        label: 'Both options cost me something',
        effect: {
          progressTo: 0.56,
          insert: [
            {
              id: uid('b'),
              kind: 'insight',
              progressTo: 0.6,
              label: 'The read',
              body: 'Then there is no clean answer to wait for, and waiting is itself one of the options — the one that pays nothing. You are choosing which cost you would rather carry.',
            },
          ],
        },
      },
      {
        id: 'known',
        label: 'I know the answer and dislike it',
        effect: {
          progressTo: 0.68,
          clearFinalCheck: true,
          insert: [
            {
              id: uid('b'),
              kind: 'insight',
              progressTo: 0.72,
              label: 'The read',
              body: 'Then this is not analysis, it is reluctance. Nothing I ask will change the answer. What is left is the act of committing to it.',
            },
          ],
        },
      },
      {
        id: 'others',
        label: 'Other people are affected',
        effect: {
          progressTo: 0.52,
          criticalUnknowns: ['How the affected parties respond.'],
          insert: [
            {
              id: uid('b'),
              kind: 'insight',
              progressTo: 0.56,
              label: 'The read',
              body: 'Other people make a decision heavier, not more complicated. You are still deciding one thing — the difference is that you will have to say it out loud afterwards.',
            },
          ],
        },
      },
    ],
  })

  beats.push({
    id: uid('b'),
    kind: 'question',
    progressTo: 0.62,
    prompt: 'If this turns out wrong, can you undo it?',
    sub: 'This is the question that decides how careful to be.',
    options: [
      {
        id: 'easy',
        label: 'Easily',
        effect: {
          progressTo: 0.84,
          known: ['Reversible at low cost.'],
          insert: [
            {
              id: uid('b'),
              kind: 'insight',
              progressTo: 0.86,
              label: 'The read',
              body: 'A reversible decision deserves speed, not care. The cost of being wrong is a week. The cost of deliberating is the same week, spent worse.',
            },
          ],
          patchDecision: {
            decisionId: 'gen_d1',
            rationale: 'Reversible. Deciding fast is worth more than deciding perfectly.',
          },
        },
      },
      {
        id: 'costly',
        label: 'At a cost',
        effect: {
          progressTo: 0.6,
          known: ['Reversible, but priced.'],
          insert: [
            {
              id: uid('b'),
              kind: 'insight',
              progressTo: 0.64,
              label: 'The read',
              body: 'Reversible-at-a-cost means the exit exists but nobody ever takes it, because by then the cost feels personal. Decide now, while you are calm, what would make you walk.',
            },
          ],
          patchDecision: {
            decisionId: 'gen_d2',
            question: 'Should I define what would make me reverse this?',
            answer: 'Define the reversal point.',
            rationale: 'The exit only stays real if you price it before you need it.',
          },
          append: [
            {
              id: uid('b'),
              kind: 'insight',
              progressTo: 0.68,
              label: 'Where this stands',
              body: 'The direction is settled. The exit is not.',
            },
            { id: uid('b'), kind: 'decision', progressTo: 0.94, decisionId: 'gen_d2' },
          ],
        },
      },
      {
        id: 'no',
        label: 'No',
        effect: {
          progressTo: 0.58,
          known: ['Effectively irreversible.'],
          criticalUnknowns: ['The terms this is committed on.'],
          insert: [
            {
              id: uid('b'),
              kind: 'insight',
              progressTo: 0.62,
              label: 'The read',
              body: 'Irreversible changes what you are actually deciding. The direction becomes the easy part. The terms you commit on become the decision.',
            },
          ],
          append: [
            {
              id: uid('b'),
              kind: 'insight',
              progressTo: 0.68,
              label: 'Where this stands',
              body: 'The direction is settled. What is not settled is what you are agreeing to.',
            },
            { id: uid('b'), kind: 'decision', progressTo: 0.94, decisionId: 'gen_d2' },
          ],
        },
      },
    ],
  })

  beats.push({ id: uid('b'), kind: 'decision', progressTo: 0.9, decisionId: 'gen_d1' })

  return {
    journey: { ...jny, needsFinalCheck: thin && mode === 'decision' },
    beats,
    reading:
      mode === 'situation'
        ? ['Reading what you wrote.', 'Looking for the decision underneath it.']
        : rich
          ? ['Reading what you wrote.', 'Keeping what matters.', 'Setting aside what does not.']
          : ['Reading what you wrote.', 'This is a clear one.'],
  }
}

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

export type DemoId = 'simple' | 'complex'

export function scenarioForDemo(id: DemoId): Scenario {
  return id === 'simple' ? buildCatScenario() : buildPartnershipScenario()
}

/**
 * Free input routes to an authored demo only on a close match, so exploring
 * the obvious phrases lands somewhere polished. Everything else adapts.
 */
export function scenarioForInput(raw: string, mode: EntryMode): Scenario {
  const t = raw.toLowerCase()
  if (mode === 'decision' && /\bcats?\b|\bkitten\b/.test(t)) return buildCatScenario()
  if (/\bpartnership\b|\bhalden\b|\bexclusivity\b/.test(t)) return buildPartnershipScenario()
  return buildGenericScenario(raw, mode)
}

/* ------------------------------------------------------------------ */
/* Journey resolution                                                  */
/* ------------------------------------------------------------------ */

/**
 * Is the decision being confirmed the one that ends the journey? Decided from
 * the live queue, not authored in advance — a user-added decision or a branch
 * that inserted work will change the answer.
 */
export function resolvesJourney(
  beats: Beat[],
  index: number,
  journey: DecisionJourney,
  confirmingId: string,
): boolean {
  const laterDecision = beats.slice(index + 1).some((b) => b.kind === 'decision')
  if (laterDecision) return false

  // Anything the user raised themselves outranks the system's own sense of
  // being finished — but not the decision they are confirming right now.
  const ownOutstanding = journey.decisions.some(
    (d) => d.id !== confirmingId && d.status !== 'confirmed' && d.source === 'user',
  )
  if (ownOutstanding) return false

  return !journey.needsFinalCheck
}

/** The fallback of §33 — only reached when the system genuinely cannot tell. */
export function finalCheckBeat(): Beat {
  return {
    id: uid('b'),
    kind: 'question',
    progressTo: 0.92,
    prompt: 'Is there anything else you need to decide?',
    sub: 'I cannot tell from what I have.',
    options: [
      { id: 'done', label: 'No — this settles it', effect: { progressTo: 1, complete: true, clearFinalCheck: true } },
      {
        id: 'more',
        label: 'Yes, there is one more',
        effect: { progressTo: 0.7, clearFinalCheck: true, promptUserDecision: true },
      },
    ],
  }
}
