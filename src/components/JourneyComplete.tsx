import { motion } from 'framer-motion'
import type { Decision, DecisionJourney } from '../../shared/types.ts'
import '../styles/complete.css'

interface Props {
  journey: DecisionJourney
  decisions: Decision[]
  closing: string
  onRestart: () => void
  onAddDecision: () => void
}

const list = { hidden: {}, show: { transition: { staggerChildren: 0.08, delayChildren: 0.28 } } }
const item = {
  hidden: { opacity: 0, y: 12, filter: 'blur(5px)' },
  show: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: 0.55, ease: [0.22, 1, 0.36, 1] } },
}

const timeOf = (ts: number | null) =>
  ts ? new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''

export default function JourneyComplete({
  journey,
  decisions,
  closing,
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
          {closing && <p className="t-quiet done__closing">{closing}</p>}
        </motion.div>

        {/* A journey can close without a commitment — Lock can conclude there
            was nothing here to decide. That is a real outcome, not an empty
            list. */}
        {decisions.length === 0 ? (
          <motion.p
            className="t-quiet done__none"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.24, ease: [0.22, 1, 0.36, 1] }}
          >
            Nothing here needed committing to.
          </motion.p>
        ) : (
        <motion.ol className="done__list" variants={list} initial="hidden" animate="show">
          {decisions.map((d) => (
            <motion.li key={d.id} className="done__item" variants={item}>
              <span className="done__seal" aria-hidden />
              <div>
                <p className="done__answer">{d.commitment}</p>
                <p className="done__meta">
                  {timeOf(d.confirmedAt)}
                  {d.source === 'user' && <span className="done__own">Yours</span>}
                </p>
              </div>
            </motion.li>
          ))}
        </motion.ol>
        )}
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
