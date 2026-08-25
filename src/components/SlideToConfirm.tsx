import { animate, motion, useMotionValue, useTransform } from 'framer-motion'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { haptic } from '../lib/haptics'
import '../styles/slide.css'

const TRACK_PAD = 4
const THUMB = 56

interface Grab {
  pointerId: number
  /** Where the pointer was when the thumb was grabbed. */
  originX: number
  /** Where the thumb was when it was grabbed — offset is preserved. */
  originThumb: number
  moved: boolean
}

export interface SlideToConfirmProps {
  label?: string
  /** Fires only after a real gesture reaches the end of the track. */
  onConfirm: () => void
  disabled?: boolean
  /** The final decision of a journey gets a slightly warmer resolve. */
  tone?: 'default' | 'final'
  /** Remounts the control between decisions. */
  resetKey?: string | number
}

export default function SlideToConfirm({
  label = 'Slide to confirm',
  onConfirm,
  disabled = false,
  tone = 'default',
  resetKey,
}: SlideToConfirmProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLDivElement>(null)
  const grabRef = useRef<Grab | null>(null)
  const atEndRef = useRef(false)

  const [maxX, setMaxX] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [resolved, setResolved] = useState(false)

  const x = useMotionValue(0)

  /* ---- geometry ------------------------------------------------- */

  useLayoutEffect(() => {
    const track = trackRef.current
    if (!track) return
    const measure = () => {
      const width = track.clientWidth - TRACK_PAD * 2 - THUMB
      setMaxX(Math.max(0, width))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(track)
    return () => ro.disconnect()
  }, [])

  /* Between decisions the control returns to its start, silently. */
  useEffect(() => {
    grabRef.current = null
    atEndRef.current = false
    setDragging(false)
    setResolved(false)
    x.set(0)
  }, [resetKey, x])

  /* ---- derived visuals ------------------------------------------ */

  const safeMax = maxX || 1
  const progress = useTransform(x, [0, safeMax], [0, 1], { clamp: true })
  const fillWidth = useTransform(x, (v) => v + TRACK_PAD + THUMB)
  const labelOpacity = useTransform(progress, [0, 0.34], [1, 0])
  const labelShift = useTransform(progress, [0, 1], [0, 16])
  const hintOpacity = useTransform(progress, [0, 0.16], [1, 0])
  const glowOpacity = useTransform(progress, [0.45, 1], [0, 1])

  /* ---- gesture --------------------------------------------------- */

  const springBack = useCallback(() => {
    atEndRef.current = false
    animate(x, 0, { type: 'spring', stiffness: 520, damping: 38, mass: 0.9 })
  }, [x])

  const commit = useCallback(() => {
    if (resolved) return
    setResolved(true)
    haptic('commit')
    animate(x, maxX, { type: 'spring', stiffness: 900, damping: 62 })
    // Let the capsule resolve before the journey moves on.
    window.setTimeout(onConfirm, 460)
  }, [maxX, onConfirm, resolved, x])

  /** The end of the track means the end of the track — not "far enough". */
  const isAtEnd = useCallback(
    (value: number) => maxX > 24 && value >= maxX - Math.max(2, maxX * 0.005),
    [maxX],
  )

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || resolved || grabRef.current) return
    // Only a press that starts on the thumb can ever move it.
    if (e.button !== 0 && e.pointerType === 'mouse') return

    const thumb = thumbRef.current
    if (!thumb) return

    thumb.setPointerCapture(e.pointerId)
    grabRef.current = {
      pointerId: e.pointerId,
      originX: e.clientX,
      originThumb: x.get(),
      moved: false,
    }
    setDragging(true)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const grab = grabRef.current
    if (!grab || grab.pointerId !== e.pointerId || resolved) return

    const delta = e.clientX - grab.originX
    if (!grab.moved && Math.abs(delta) > 1.5) grab.moved = true

    const next = Math.min(maxX, Math.max(0, grab.originThumb + delta))
    x.set(next)

    // A single tick when the thumb first meets the end, and again if it leaves.
    const end = isAtEnd(next)
    if (end !== atEndRef.current) {
      atEndRef.current = end
      if (end) haptic('edge')
    }
  }

  const endGesture = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const grab = grabRef.current
    if (!grab || grab.pointerId !== e.pointerId) return
    grabRef.current = null
    setDragging(false)

    const thumb = thumbRef.current
    if (thumb?.hasPointerCapture(e.pointerId)) thumb.releasePointerCapture(e.pointerId)

    if (resolved) return

    // A tap is not a decision. Neither is a release short of the end.
    if (cancelled || !grab.moved || !isAtEnd(x.get())) {
      haptic('reset')
      springBack()
      return
    }
    commit()
  }

  /* ---- keyboard path -------------------------------------------- */

  const nudge = (direction: 1 | -1) => {
    if (disabled || resolved || maxX <= 0) return
    const step = maxX / 8
    const next = Math.min(maxX, Math.max(0, x.get() + step * direction))
    animate(x, next, { type: 'spring', stiffness: 700, damping: 46 })
    if (isAtEnd(next)) {
      atEndRef.current = true
      haptic('edge')
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        e.preventDefault()
        nudge(1)
        break
      case 'ArrowLeft':
      case 'ArrowDown':
        e.preventDefault()
        nudge(-1)
        break
      case 'Home':
        e.preventDefault()
        animate(x, 0, { type: 'spring', stiffness: 700, damping: 46 })
        break
      case 'End':
        e.preventDefault()
        animate(x, maxX, { type: 'spring', stiffness: 700, damping: 46 })
        atEndRef.current = maxX > 24
        break
      case 'Enter':
      case ' ':
        // Still requires the thumb to be at the end — never a bare press.
        e.preventDefault()
        if (isAtEnd(x.get())) commit()
        break
      default:
        break
    }
  }

  const [ariaValue, setAriaValue] = useState(0)
  useEffect(() => progress.on('change', (v) => setAriaValue(Math.round(v * 100))), [progress])

  return (
    <div
      className={[
        'slide',
        dragging ? 'is-dragging' : '',
        resolved ? 'is-resolved' : '',
        disabled ? 'is-disabled' : '',
        tone === 'final' ? 'is-final' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="slide__track" ref={trackRef}>
        <motion.div className="slide__fill" style={{ width: fillWidth }} aria-hidden />
        <motion.div className="slide__glow" style={{ opacity: glowOpacity }} aria-hidden />

        <motion.span
          className="slide__label"
          style={{ opacity: labelOpacity, x: labelShift }}
          aria-hidden
        >
          <span className="slide__label-text">{resolved ? 'Confirmed' : label}</span>
        </motion.span>

        <motion.span className="slide__hint" style={{ opacity: hintOpacity }} aria-hidden>
          <i /><i /><i />
        </motion.span>

        <motion.div
          ref={thumbRef}
          className="slide__thumb"
          style={{ x }}
          /* Scale lives in the same transform as x. As a separate CSS `scale`
             property it would multiply the translation and push the thumb
             ahead of the finger at the far end of the track. */
          animate={{ scale: dragging && !resolved ? 1.035 : 1 }}
          transition={{ type: 'spring', stiffness: 520, damping: 32 }}
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={ariaValue}
          aria-valuetext={`${ariaValue}% — slide fully right to confirm`}
          aria-disabled={disabled || undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => endGesture(e, false)}
          onPointerCancel={(e) => endGesture(e, true)}
          onKeyDown={onKeyDown}
          onContextMenu={(e) => e.preventDefault()}
        >
          <span className="slide__glyph" aria-hidden>
            <svg viewBox="0 0 24 24" className="slide__glyph-arrow" fill="none">
              <path
                d="M9 5.5 15.5 12 9 18.5"
                stroke="currentColor"
                strokeWidth="2.1"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <svg viewBox="0 0 24 24" className="slide__glyph-check" fill="none">
              <path
                d="M5.5 12.4 10 16.9 18.5 7.6"
                stroke="currentColor"
                strokeWidth="2.1"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </motion.div>
      </div>
    </div>
  )
}
