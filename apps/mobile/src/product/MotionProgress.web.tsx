import { motion } from 'motion/react';
import { useReducedMotion } from './motion';
import { motionTokens } from './motion/tokens';
export function MotionProgress({ value, color }: { value: number; color: string }) {
  const reduced = useReducedMotion();
  return <motion.div aria-hidden initial={false} animate={{ scaleX: Math.max(0, Math.min(1, value)) }} transition={reduced ? { duration: 0 } : { type: 'spring', ...motionTokens.spring.lead }} style={{ height: '100%', backgroundColor: color, borderRadius: 4, transformOrigin: 'left center' }} />;
}
