import { useEffect, useState } from 'react'

/**
 * Keeps the app sized to the *actually visible* area of a real mobile browser.
 *
 * Why not just 100vh: on iOS Safari and Chrome, `vh` is the largest possible
 * viewport and ignores the toolbars, so bottom-anchored UI ends up underneath
 * browser chrome. `dvh` is correct but only updates on layout, and it does not
 * account for the software keyboard at all.
 *
 * So: CSS carries `dvh` as the declarative baseline (and the value used before
 * JS runs, and on browsers without visualViewport), and this hook refines it
 * with the live `visualViewport` measurement — which shrinks when the toolbar
 * expands, grows when it collapses on scroll, and shrinks again when the
 * keyboard opens.
 *
 * Nothing here simulates browser UI. It only measures what the browser leaves us.
 */
export interface AppViewport {
  /** Height of the visible area, in px. */
  height: number
  /** Height of the software keyboard overlay, in px. 0 when closed. */
  keyboard: number
  keyboardOpen: boolean
}

const KEYBOARD_THRESHOLD = 110

export function useAppViewport(): AppViewport {
  const [vp, setVp] = useState<AppViewport>(() => ({
    height: typeof window === 'undefined' ? 0 : window.innerHeight,
    keyboard: 0,
    keyboardOpen: false,
  }))

  useEffect(() => {
    const root = document.documentElement
    const vv = window.visualViewport

    let frame = 0
    const measure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const height = Math.round(vv ? vv.height : window.innerHeight)
        const offsetTop = Math.round(vv ? vv.offsetTop : 0)

        // Anything the layout viewport has that the visual viewport does not is
        // an overlay — on mobile that is the keyboard.
        const overlay = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0
        const keyboard = overlay > KEYBOARD_THRESHOLD ? Math.round(overlay) : 0

        root.style.setProperty('--app-h', `${height}px`)
        root.style.setProperty('--app-top', `${offsetTop}px`)
        root.style.setProperty('--kb-h', `${keyboard}px`)
        root.classList.toggle('kb-open', keyboard > 0)

        setVp((prev) =>
          prev.height === height && prev.keyboard === keyboard
            ? prev
            : { height, keyboard, keyboardOpen: keyboard > 0 },
        )
      })
    }

    measure()

    if (vv) {
      vv.addEventListener('resize', measure)
      vv.addEventListener('scroll', measure)
    }
    window.addEventListener('resize', measure)
    window.addEventListener('orientationchange', measure)

    return () => {
      cancelAnimationFrame(frame)
      if (vv) {
        vv.removeEventListener('resize', measure)
        vv.removeEventListener('scroll', measure)
      }
      window.removeEventListener('resize', measure)
      window.removeEventListener('orientationchange', measure)
    }
  }, [])

  return vp
}

/** Respects the OS "reduce motion" setting. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const apply = () => setReduced(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])
  return reduced
}
