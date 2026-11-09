import type { ReactNode } from 'react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { useReducedMotion } from './motion';
import { motionTokens } from './motion/tokens';

function Row({ children }: { children: ReactNode }) {
  const reduced = useReducedMotion();
  const present = useIsPresent();
  return <motion.div layout={reduced ? false : 'position'} inert={!present || undefined} aria-hidden={!present || undefined}
    initial={{ opacity: 0, transform: reduced ? 'none' : 'translateY(8px)' }}
    animate={{ opacity: 1, transform: 'translateY(0px)' }} exit={{ opacity: 0, transform: reduced ? 'none' : 'translateY(-4px)' }}
    transition={{ duration: reduced ? 0 : motionTokens.base / 1000, ease: motionTokens.ease, layout: { type: 'spring', ...motionTokens.spring.lead } }}
    style={{ position: 'relative', pointerEvents: present ? undefined : 'none' }}>{children}</motion.div>;
}

export function FlowList<T extends { id: string }>({ items, renderItem }: { items: T[]; renderItem(item: T): ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}><AnimatePresence initial={false}>
    {items.map((item) => <Row key={item.id}>{renderItem(item)}</Row>)}
  </AnimatePresence></div>;
}
