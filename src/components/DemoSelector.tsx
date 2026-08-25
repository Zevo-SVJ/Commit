interface Props {
  onDemo: (demo: 'simple' | 'complex') => void
}

/** Deliberately quiet: a way in for testing, not a feature of the product. */
export default function DemoSelector({ onDemo }: Props) {
  return (
    <div className="demos">
      <span className="demos__label">Try a decision</span>
      <div className="demos__row">
        <button type="button" className="demos__chip" onClick={() => onDemo('simple')}>
          Simple
        </button>
        <span className="demos__sep" aria-hidden />
        <button type="button" className="demos__chip" onClick={() => onDemo('complex')}>
          Complex
        </button>
      </div>
    </div>
  )
}
