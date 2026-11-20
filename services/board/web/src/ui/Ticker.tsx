// A number that counts to its new value (≈450ms, easing out) instead of jumping; instant with reduced motion.
import { useEffect, useRef, useState } from "react";

export function useTicker(value: number, ms = 450): number {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    if (start === value || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      from.current = value;
      setShown(value);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      const v = start + (value - start) * (1 - Math.pow(1 - k, 3));
      from.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return shown;
}

export function Ticker({ value, format = (n) => String(Math.round(n)) }: { value: number; format?: (n: number) => string }) {
  return <>{format(useTicker(value))}</>;
}
