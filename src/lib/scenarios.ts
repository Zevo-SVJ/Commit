import type {
  Beat,
  Decision,
  DecisionJourney,
  Scenario,
} from './types'

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

let seq = 0
export const uid = (prefix: string) => `${prefix}_${(seq++).toString(36)}_${Date.now().toString(36)}`

function decision(
  partial: Pick<Decision, 'id' | 'question' | 'answer' | 'rationale' | 'stage'> &
    Partial<Decision>,
): Decision {
  return {
    source: 'system',
    status: 'proposed',
    is_final: false,
    timestamp: null,
    ...partial,
  }
}

function journey(partial: Partial<DecisionJourney> & Pick<DecisionJourney, 'title' | 'original_problem'>): DecisionJourney {
  return {
    id: uid('jny'),
    current_stage: 1,
    decisions: [],
    status: 'active',
    internal_progress: 0.12,
    known_information: [],
    unknown_information: [],
    critical_unknowns: [],
    next_action: '',
    needsFinalCheck: false,
    ...partial,
  }
}

/* ================================================================== */
/* DEMO 1 — SIMPLE. One decision resolves the whole journey.           */
/* ================================================================== */

export function buildCatScenario(): Scenario {
  const d1 = decision({
    id: 'dec_cat',
    question: 'Should I get a cat?',
    answer: 'Get the cat.',
    rationale: 'Nothing you raised is a reason not to. It is a thing to plan for.',
    stage: 1,
  })

  const jny = journey({
    title: 'Should I get a cat?',
    original_problem: 'Should I get a cat?',
    decisions: [d1],
    internal_progress: 0.18,
    known_information: ['You want one.', 'You have been circling this for a while.'],
    unknown_information: ['What is actually stopping you.'],
    next_action: 'Name the obstacle, then decide.',
  })

  const beats: Beat[] = [
    {
      id: uid('b'),
      kind: 'context',
      progressTo: 0.24,
      label: 'What I understand',
      lead: 'This one is small on paper and large in your head.',
      facts: [
        'You already want the cat.',
        'You are looking for permission, or for a reason not to.',
        'There is only one thing to decide here.',
      ],
    },
    {
      id: uid('b'),
      kind: 'question',
      progressTo: 0.42,
      prompt: 'What is actually holding you back?',
      sub: 'One thing. The real one.',
      allowFree: true,
      freePlaceholder: 'In your own words…',
      freeEffect: {
        progressTo: 0.7,
        insert: [
          {
            id: uid('b'),
            kind: 'insight',
            progressTo: 0.74,
            label: 'The read',
            body: 'You named it without hesitating, which means you already knew it. That is usually the sign that it is a condition to handle, not a reason to stop.',
          },
        ],
      },
      options: [
        {
          id: 'time',
          label: 'I am never home',
          effect: {
            progressTo: 0.72,
            known: ['Out of the house most of the day.'],
            insert: [
              {
                id: uid('b'),
                kind: 'insight',
                progressTo: 0.76,
                label: 'The read',
                body: 'A cat asks for less of your day than worrying about the cat is currently costing you. Nine hours alone is ordinary for them. This is a scheduling detail, not an objection.',
              },
            ],
            patchDecision: {
              decisionId: 'dec_cat',
              rationale: 'Your hours are workable. This was never the real obstacle.',
            },
          },
        },
        {
          id: 'travel',
          label: 'I travel',
          effect: {
            progressTo: 0.7,
            known: ['Travels regularly.'],
            insert: [
              {
                id: uid('b'),
                kind: 'insight',
                progressTo: 0.76,
                label: 'The read',
                body: 'Travel is the one that is genuinely solvable, and cheaply. It costs about the price of a dinner per day and one person you trust with a key. Solve it once and it stays solved.',
              },
            ],
            patchDecision: {
              decisionId: 'dec_cat',
              rationale: 'Travel is a logistics problem with a known price. It is not a reason.',
            },
          },
        },
        {
          id: 'money',
          label: 'The cost',
          effect: {
            progressTo: 0.68,
            known: ['Cost-sensitive.'],
            criticalUnknowns: ['Appetite for an unexpected veterinary year.'],
            insert: [
              {
                id: uid('b'),
                kind: 'insight',
                progressTo: 0.74,
                label: 'The read',
                body: 'The food is not the number. The vet is. Decide whether you could absorb one bad year, not twelve good ones — if the answer is yes, the cost question is closed.',
              },
            ],
            patchDecision: {
              decisionId: 'dec_cat',
              rationale: 'Budget for one bad year rather than twelve good ones, and the cost stops being the question.',
            },
          },
        },
        {
          id: 'nothing',
          label: 'Honestly, nothing',
          effect: {
            progressTo: 0.82,
            insert: [
              {
                id: uid('b'),
                kind: 'insight',
                progressTo: 0.84,
                label: 'The read',
                body: 'Then this was decided before you opened this. What is left is not deliberation. It is the act of making it real.',
              },
            ],
            patchDecision: {
              decisionId: 'dec_cat',
              rationale: 'You have no objection left. Only the moment of saying so.',
            },
          },
        },
      ],
    },
    { id: uid('b'), kind: 'decision', progressTo: 0.9, decisionId: 'dec_cat' },
  ]

  return {
    journey: jny,
    beats,
    reading: ['Reading what you wrote.', 'This is one decision, not several.'],
  }
}

/* ================================================================== */
/* DEMO 2 — MULTI-STAGE. Three decisions, and a genuine setback.       */
/* ================================================================== */

export function buildPartnershipScenario(): Scenario {
  const d1 = decision({
    id: 'dec_pursue',
    question: 'Should I pursue this partnership?',
    answer: 'Pursue the partnership.',
    rationale: 'The money is real and the risk is in the terms, not the relationship.',
    stage: 1,
  })
  const d2 = decision({
    id: 'dec_negotiate',
    question: 'Should I accept the terms as offered?',
    answer: 'Negotiate before agreeing.',
    rationale: 'Signing as offered prices eighteen months of your market at zero.',
    stage: 2,
  })
  const d3 = decision({
    id: 'dec_sign',
    question: 'Should I sign the final agreement?',
    answer: 'Sign the agreement.',
    rationale: 'The terms now match what you said you would accept.',
    stage: 3,
  })

  const jny = journey({
    title: 'The Halden partnership',
    original_problem: 'Should I pursue this partnership?',
    decisions: [d1, d2, d3],
    internal_progress: 0.14,
    known_information: [
      '€120,000 offered for a nine-month build.',
      '18 months of category exclusivity attached.',
      'Marlowe is in the same category and interested.',
    ],
    unknown_information: ['How much of next year is already sold.'],
    critical_unknowns: ['What the exclusivity actually costs you.'],
    next_action: 'Establish whether the year can absorb this.',
  })

  const beats: Beat[] = [
    {
      id: uid('b'),
      kind: 'context',
      progressTo: 0.22,
      label: 'What I understand',
      lead: 'Halden & Co. want nine months of your work and eighteen months of your market.',
      facts: [
        '€120,000 for a nine-month build.',
        'Exclusivity in their category for 18 months — nine of them after delivery.',
        'Marlowe sits in that category, and has been circling.',
      ],
    },
    {
      id: uid('b'),
      kind: 'question',
      progressTo: 0.34,
      prompt: 'How much of next year is already committed?',
      sub: 'This decides whether the exclusivity costs you anything real.',
      options: [
        {
          id: 'none',
          label: 'Nothing yet',
          effect: {
            progressTo: 0.46,
            known: ['Next year is open.'],
            insert: [
              {
                id: uid('b'),
                kind: 'insight',
                progressTo: 0.5,
                label: 'The read',
                body: 'An open year makes €120,000 a floor rather than a ceiling. The exclusivity is expensive in theory and cheap in practice — you would be blocking work you do not currently have.',
              },
            ],
          },
        },
        {
          id: 'half',
          label: 'About half',
          effect: {
            progressTo: 0.44,
            known: ['Roughly half of next year is committed.'],
            insert: [
              {
                id: uid('b'),
                kind: 'insight',
                progressTo: 0.48,
                label: 'The read',
                body: 'Half committed means this fills the year rather than defining it. The exclusivity is the only part that reaches past the work itself — which is where your attention belongs.',
              },
            ],
          },
        },
        {
          id: 'most',
          label: 'Almost all of it',
          effect: {
            progressTo: 0.4,
            known: ['Next year is nearly full.'],
            criticalUnknowns: ['What gets displaced to make room.'],
            insert: [
              {
                id: uid('b'),
                kind: 'insight',
                progressTo: 0.46,
                label: 'The read',
                body: 'Then this is not an addition, it is a replacement. Something already on the books gets displaced, and the €120,000 has to beat what it pushes out — not zero.',
              },
            ],
            patchDecision: {
              decisionId: 'dec_pursue',
              rationale: 'Worth pursuing, but only as a replacement for weaker committed work.',
            },
          },
        },
      ],
    },
    { id: uid('b'), kind: 'decision', progressTo: 0.56, decisionId: 'dec_pursue' },

    {
      id: uid('b'),
      kind: 'insight',
      progressTo: 0.6,
      label: 'Where this stands',
      body: 'The question is no longer whether. It is on what terms — and terms are the part of this that is still moveable.',
    },
    {
      id: uid('b'),
      kind: 'question',
      progressTo: 0.66,
      prompt: 'Which term would you actually walk away over?',
      sub: 'Only one of these is a line. The rest are preferences.',
      options: [
        {
          id: 'exclusivity',
          label: 'The exclusivity window',
          effect: {
            progressTo: 0.72,
            known: ['Exclusivity is the walk-away term.'],
            patchDecision: {
              decisionId: 'dec_negotiate',
              rationale: 'Eighteen months is the only term you called a line. Open there and concede elsewhere.',
            },
          },
        },
        {
          id: 'payment',
          label: 'The payment schedule',
          effect: {
            progressTo: 0.72,
            known: ['Cash timing is the walk-away term.'],
            patchDecision: {
              decisionId: 'dec_negotiate',
              rationale: 'Cash timing is your line. Trade months of exclusivity for it if you have to.',
            },
          },
        },
        {
          id: 'scope',
          label: 'The scope of the build',
          effect: {
            progressTo: 0.72,
            known: ['Scope is the walk-away term.'],
            patchDecision: {
              decisionId: 'dec_negotiate',
              rationale: 'Scope is your line. A fixed scope is worth more to you here than a higher number.',
            },
          },
        },
      ],
    },
    { id: uid('b'), kind: 'decision', progressTo: 0.78, decisionId: 'dec_negotiate' },

    /* The setback. Progress falls. */
    {
      id: uid('b'),
      kind: 'insight',
      progressTo: 0.54,
      tone: 'shift',
      label: 'New information',
      body: 'Halden came back. Exclusivity down to twelve months — and they now want the IP for what you build.',
    },
    {
      id: uid('b'),
      kind: 'question',
      progressTo: 0.58,
      prompt: 'Does the IP change your answer?',
      sub: 'They gave up six months and asked for something larger.',
      options: [
        {
          id: 'no',
          label: 'No — the window mattered more',
          effect: {
            progressTo: 0.8,
            known: ['IP is acceptable; the window was the real cost.'],
            patchDecision: {
              decisionId: 'dec_sign',
              answer: 'Sign the agreement.',
              rationale: 'You got the term you called a line. The IP was never the part you were protecting.',
            },
          },
        },
        {
          id: 'yes',
          label: 'Yes — that is the real cost',
          effect: {
            progressTo: 0.74,
            criticalUnknowns: ['Whether Halden will carve out the IP.'],
            insert: [
              {
                id: uid('b'),
                kind: 'insight',
                progressTo: 0.78,
                label: 'The read',
                body: 'Then the six months they offered was not a concession, it was a trade — and you would be paying more than you were before. The agreement is still signable, but not as written.',
              },
            ],
            patchDecision: {
              decisionId: 'dec_sign',
              question: 'Should I sign with the IP carved out?',
              answer: 'Sign, with the IP carved out.',
              rationale: 'The window is settled. The IP is the last term, and it is the one you are keeping.',
            },
          },
        },
      ],
    },
    { id: uid('b'), kind: 'decision', progressTo: 0.94, decisionId: 'dec_sign' },
  ]

  return {
    journey: jny,
    beats,
    reading: [
      'Reading what you wrote.',
      'There is more than one decision inside this.',
      'Starting with the first.',
    ],
  }
}
