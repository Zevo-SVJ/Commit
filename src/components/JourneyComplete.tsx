import { motion } from 'framer-motion'
import type { Decision, DecisionJourney as Journey } from '../lib/types'
import '../styles/complete.css'

interface Props {
  journey: Journey
  decisions: Decision[]
  onRestart: () => void
  onAddDecision: () => void
}

const list = {
  hidden: {},
  show: { transition: { staggerChildren: 0.09, delayChildren: 0.3 } },
}
const item = {
  hidden: { opacity: 0, y: 12, filter: 'blur(5px)' },
  show: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: 0.55, ease: [0.22, 1, 0.36, 1] } },
}

export default function JourneyComplete({
  journey,
  decisions,
  onRestart,
  onAddDecision,
}: Props) {
  return (
    <div className="screen done">
      <div className="screen__body done__body">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        >
          <p className="t-eyebrow done__eyebrow">Decided</p>
          <h1 className="t-display done__title">{journey.title}</h1>
        </motion.div>

        <motion.ol className="done__list" variants={list} initial="hidden" animate="show">
          {decisions.map((d) => (
            <motion.li key={d.id} className="done__item" variants={item}>
              <span className="done__seal" aria-hidden />
              <div>
                <p className="done__answer">{d.answer}</p>
                <p className="done__meta">
                  {d.timestamp
                    ? new Date(d.timestamp).toLocaleTimeString([], {
                        hour: 'numeric',
                        minute: '2-digit',
                      })
                    : ''}
                  {d.source === 'user' && <span className="done__own">Yours</span>}
                </p>
              </div>
            </motion.li>
          ))}
        </motion.ol>
      </div>

      <div className="screen__dock">
        <button type="button" className="btn btn--primary" onClick={onRestart}>
          Start something else
        </button>
        <div className="subtle-row">
          <button type="button" className="subtle-action" onClick={onAddDecision}>
            Actually — there’s one more decision
          </button>
        </div>
      </div>
    </div>
  )
}
