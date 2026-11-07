import { motion } from 'motion/react';
import { useReducedMotion } from './motion';
import { motionTokens } from './motion/tokens';
export function SelectionHalo({ active, group, color }: { active: boolean; group: string; color: string }) {
  const reduced = useReducedMotion();
  return active ? <motion.div aria-hidden layoutId={reduced ? undefined : group} transition={reduced ? { duration: 0 } : { type: 'spring', ...motionTokens.spring.lead }} style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: `2px solid ${color}`, pointerEvents: 'none', zIndex: 2 }} /> : null;
}
