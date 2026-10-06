import { useEffect, useRef, useState } from 'react'

// count-up for real numbers on tiles and status — 0 → target over 600ms,
// instant when the user asked for reduced motion or the number is not countable
export function useCountUp(target, duration = 600) {
  const [val, setVal] = useState(target)
  const fromRef = useRef(target)

  useEffect(() => {
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const from = fromRef.current
    if (reduce || !isFinite(target) || from === target) {
      fromRef.current = target
      setVal(target)
      return
    }
    let raf
    const t0 = performance.now()
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / duration)
      const eased = 1 - Math.pow(1 - p, 3)
      const v = Math.round(from + (target - from) * eased)
      fromRef.current = v
      setVal(v)
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, duration])

  return val
}
