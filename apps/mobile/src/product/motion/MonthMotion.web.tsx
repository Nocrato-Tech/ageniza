import { createContext, useContext, useLayoutEffect, useState } from 'react';
import { AnimatePresence, animate, motion, useMotionValue, usePresence } from 'motion/react';
import { useReducedMotion } from '../motion';
import { motionTokens } from './tokens';
import type { MonthMotionProps } from './MonthMotion';

type MonthChange = { direction: number; reduced: boolean };
const MonthTransition = createContext<MonthChange>({ direction: 1, reduced: true });

export function MonthMotion({ identity, children, variant = 'grid', onExitComplete }: MonthMotionProps) {
  const reduced = useReducedMotion();
  const [change, setChange] = useState({ identity, direction: 1, changed: false });
  if (change.identity !== identity) setChange({ identity, direction: identity > change.identity ? 1 : -1, changed: true });
  return <div data-month-viewport={variant} style={{ position: 'relative', overflow: 'clip', minWidth: 0 }}>
    <MonthTransition.Provider value={{ direction: change.direction, reduced }}><AnimatePresence initial={false} onExitComplete={onExitComplete}>
      <MonthPanel key={identity} identity={identity} variant={variant} entering={change.changed}>{children}</MonthPanel>
    </AnimatePresence></MonthTransition.Provider>
  </div>;
}

function MonthPanel({ identity, children, variant, entering }: MonthMotionProps & { entering: boolean }) {
  const [present, safeToRemove] = usePresence();
  const { direction, reduced } = useContext(MonthTransition);
  const distance = variant === 'title' ? 24 : 100;
  const unit = variant === 'title' ? 'px' : '%';
  const enter = `translate3d(${direction * distance}${unit}, 0, 0)`;
  const exit = `translate3d(${-direction * distance}${unit}, 0, 0)`;
  const transform = useMotionValue(entering && !reduced ? enter : 'translate3d(0%, 0, 0)');
  const opacity = useMotionValue(entering && !reduced && variant === 'title' ? 0 : 1);
  useLayoutEffect(() => {
    let cancelled = false;
    const target = { transform: present || reduced ? 'translate3d(0%, 0, 0)' : exit, opacity: present ? 1 : variant === 'title' || reduced ? 0 : 1 };
    if (reduced) {
      transform.jump(target.transform);
      opacity.jump(target.opacity);
      queueMicrotask(() => { if (!cancelled && !present) safeToRemove?.(); });
      return () => { cancelled = true; };
    }
    const options = { duration: motionTokens.slow / 1000, ease: motionTokens.ease };
    const movement = animate(transform, target.transform, options);
    const visibility = animate(opacity, target.opacity, options);
    void Promise.all([movement, visibility]).then(() => { if (!cancelled && !present) safeToRemove?.(); });
    return () => { cancelled = true; movement.stop(); visibility.stop(); };
  }, [transform, opacity, present, reduced, exit, variant, safeToRemove]);
  return <motion.div data-month-panel={identity} data-month-present={present} aria-hidden={!present || undefined} inert={!present}
    onClickCapture={(event) => { if (!present) { event.preventDefault(); event.stopPropagation(); } }}
    style={{ position: present ? 'relative' : 'absolute', top: 0, left: 0, width: '100%', pointerEvents: present ? 'auto' : 'none', transform, opacity }}>
    {children}
  </motion.div>;
}
