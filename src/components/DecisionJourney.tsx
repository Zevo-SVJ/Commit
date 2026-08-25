import type { Decision, DecisionJourney as Journey } from '../../shared/types.ts'
import Sheet from './Sheet'

interface Props {
  open: boolean
  journey: Journey
  pendingId: string | null
  onClose: () => void
  onAdd: () => void
}

const timeOf = (ts: number | null) =>
  ts ? new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''

/**
 * The journey so far, on request. Never in the way of the current decision,
 * and never a dashboard.
 */
export default function DecisionJourneySheet({
  open,
  journey,
  pendingId,
  onClose,
  onAdd,
}: Props) {
  const shown: Decision[] = journey.decisions

  return (
    <Sheet open={open} title="This journey" onClose={onClose}>
      <p className="journey__problem">{journey.originalSituation}</p>

      <ol className="journey__list">
        {shown.map((d) => {
          const state =
            d.status === 'confirmed' ? 'confirmed' : d.id === pendingId ? 'active' : 'queued'
          return (
            <li key={d.id} className={`journey__item is-${state}`}>
              <span className="journey__node" aria-hidden />
              <div className="journey__content">
                <p className="journey__answer">{d.commitment}</p>
                <p className="journey__meta">
                  {state === 'confirmed' && `Confirmed ${timeOf(d.confirmedAt)}`}
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
