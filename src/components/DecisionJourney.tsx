import type { Decision, DecisionJourney as Journey } from '../lib/types'
import Sheet from './Sheet'

interface Props {
  open: boolean
  journey: Journey
  decisions: Decision[]
  activeId: string | null
  onClose: () => void
  onAdd: () => void
}

const timeOf = (ts: number | null) =>
  ts
    ? new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : ''

/** The whole journey, on request. Never in the way of the current decision. */
export default function DecisionJourney({
  open,
  journey,
  decisions,
  activeId,
  onClose,
  onAdd,
}: Props) {
  return (
    <Sheet open={open} title="This journey" onClose={onClose}>
      <p className="journey__problem">{journey.original_problem}</p>

      <ol className="journey__list">
        {decisions.map((d) => {
          const state =
            d.status === 'confirmed' ? 'confirmed' : d.id === activeId ? 'active' : 'queued'
          return (
            <li key={d.id} className={`journey__item is-${state}`}>
              <span className="journey__node" aria-hidden />
              <div className="journey__content">
                <p className="journey__answer">
                  {state === 'queued' ? d.question : d.answer}
                </p>
                <p className="journey__meta">
                  {state === 'confirmed' && `Confirmed ${timeOf(d.timestamp)}`}
                  {state === 'active' && 'Deciding now'}
                  {state === 'queued' && 'Not yet reached'}
                  {d.source === 'user' && <span className="journey__own">Yours</span>}
                </p>
              </div>
            </li>
          )
        })}
      </ol>

      <button type="button" className="btn btn--ghost journey__add" onClick={onAdd}>
        Add a decision of your own
      </button>
    </Sheet>
  )
}
