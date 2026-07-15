import type React from 'react';
import { useEffect, useRef } from 'react';
import {
  motion,
  animate,
  useInView,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from 'framer-motion';

export const REVEAL_EASE = [0.22, 1, 0.36, 1] as const;

export function Reveal(props: {
  children: React.ReactNode;
  delay?: number;
  y?: number;
  className?: string;
}) {
  const { children, delay, y, className } = props;
  const reducedMotion = useReducedMotion();

  if (reducedMotion) {
    return <div className={className}>{children}</div>;
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: y ?? 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.5, delay: delay ?? 0, ease: REVEAL_EASE }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

export function CountUp(props: {
  value: number;
  suffix?: string;
  className?: string;
  style?: React.CSSProperties;
  durationMs?: number;
}) {
  const { value, suffix = '%', className, style, durationMs } = props;
  const ref = useRef<HTMLSpanElement>(null);
  const reducedMotion = useReducedMotion();
  const inView = useInView(ref, { once: true, amount: 0.6 });
  const count = useMotionValue(0);
  const display = useTransform(count, (latest) => `${Math.round(latest)}${suffix}`);

  useEffect(() => {
    if (reducedMotion || !inView) {
      return;
    }
    const controls = animate(count, value, {
      duration: (durationMs ?? 1200) / 1000,
      ease: REVEAL_EASE,
    });
    return () => controls.stop();
  }, [inView, reducedMotion, value, durationMs, count]);

  if (reducedMotion) {
    return (
      <motion.span ref={ref} className={className} style={style}>
        {`${value}${suffix}`}
      </motion.span>
    );
  }

  return (
    <motion.span ref={ref} className={className} style={style}>
      {display}
    </motion.span>
  );
}
