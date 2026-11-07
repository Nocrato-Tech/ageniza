import { motion } from 'motion/react';
import { useReducedMotion } from './motion';
import { motionTokens } from './motion/tokens';
export function ClockHighlight({ active, group, color, border }: { active: boolean; group: string; color: string; border: string }) {
  const reduced = useReducedMotion();
  return active ? <motion.div aria-hidden layoutId={reduced ? undefined : group} transition={reduced ? { duration: 0 } : { type: 'spring', ...motionTokens.spring.lead }} style={{ position: 'absolute', inset: 0, borderRadius: 12, backgroundColor: color, border: `1px solid ${border}`, pointerEvents: 'none' }} /> : null;
}
