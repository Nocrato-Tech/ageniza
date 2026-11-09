import type { ReactNode } from 'react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { useReducedMotion } from './motion';
import { motionTokens } from './motion/tokens';

function Panel({ children }: { children: ReactNode }) {
  const reduced = useReducedMotion();
  const present = useIsPresent();
  return <motion.div inert={!present || undefined} aria-hidden={!present || undefined}
    initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
    transition={{ duration: reduced ? 0 : motionTokens.base / 1000, ease: motionTokens.ease }}
    style={{ overflow: 'hidden' }}><div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>{children}</div></motion.div>;
}

export function Disclosure({ open, children }: { open: boolean; children: ReactNode }) {
  return <AnimatePresence initial={false}>{open && <Panel key="panel">{children}</Panel>}</AnimatePresence>;
}
