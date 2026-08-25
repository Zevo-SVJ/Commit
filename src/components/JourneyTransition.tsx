import { AnimatePresence, motion } from 'framer-motion'
import type { ReactNode } from 'react'

/**
 * One continuous journey rather than a series of screens: the current thing
 * recedes upward and the next rises into its place. Never a hard cut.
 */
export default function JourneyTransition({
  stepKey,
  children,
}: {
  stepKey: string
  children: ReactNode
}) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={stepKey}
        className="ws__card"
        initial={{ opacity: 0, y: 18, filter: 'blur(8px)' }}
        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
        exit={{ opacity: 0, y: -16, filter: 'blur(8px)' }}
        transition={{ duration: 0.44, ease: [0.22, 1, 0.36, 1] }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  )
}
