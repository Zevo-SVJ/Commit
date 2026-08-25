import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import '../styles/reading.css'

interface Props {
  lines: string[]
  onDone: () => void
  reduced?: boolean
}

/**
 * The moment between "I said it" and "the system has it".
 * Not a spinner and not a fake typing animation — a short, finite sequence
 * that ends on its own.
 */
export default function Reading({ lines, onDone, reduced = false }: Props) {
  const [step, setStep] = useState(0)
  const dwell = reduced ? 320 : 900

  useEffect(() => {
    if (step >= lines.length) {
      const t = window.setTimeout(onDone, reduced ? 120 : 460)
      return () => window.clearTimeout(t)
    }
    const t = window.setTimeout(() => setStep((s) => s + 1), step === 0 ? dwell * 0.6 : dwell)
    return () => window.clearTimeout(t)
  }, [step, lines.length, onDone, dwell, reduced])

  return (
    <div className="screen reading">
      <div className="reading__inner">
        <motion.span
          className="reading__pulse"
          aria-hidden
          animate={reduced ? {} : { scale: [1, 1.28, 1], opacity: [0.5, 0.9, 0.5] }}
          transition={{ duration: 2.1, repeat: Infinity, ease: [0.65, 0, 0.35, 1] }}
        />
        <div className="reading__lines" aria-live="polite">
          {lines.map((line, i) => (
            <motion.p
              key={line}
              className="reading__line"
              initial={{ opacity: 0, y: 10, filter: 'blur(7px)' }}
              animate={
                i < step
                  ? { opacity: i === step - 1 ? 1 : 0.28, y: 0, filter: 'blur(0px)' }
                  : { opacity: 0, y: 10, filter: 'blur(7px)' }
              }
              transition={{ duration: reduced ? 0.12 : 0.6, ease: [0.22, 1, 0.36, 1] }}
            >
              {line}
            </motion.p>
          ))}
        </div>
      </div>
    </div>
  )
}
