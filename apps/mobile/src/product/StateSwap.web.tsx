import type { ReactNode } from 'react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { useReducedMotion } from './motion';
import { motionTokens } from './motion/tokens';
function Panel({ children }: { children: ReactNode }) {
 const present = useIsPresent(); const reduced = useReducedMotion();
 return <motion.div inert={!present || undefined} aria-hidden={!present || undefined} initial={{opacity:0,transform:reduced?'none':'translateY(6px)'}} animate={{opacity:1,transform:'none'}} exit={{opacity:0,transform:reduced?'none':'translateY(-4px)'}} transition={{duration:reduced?0:motionTokens.fast/1000,ease:motionTokens.ease}} style={{position:present?'relative':'absolute',inset:present?undefined:0,display:'flex',flexDirection:'column',gap:16,pointerEvents:present?undefined:'none'}}>{children}</motion.div>;
}
export function StateSwap({ identity, children }: { identity: string; children: ReactNode }) {
 return <div style={{position:'relative',minWidth:0,overflow:'clip'}}><AnimatePresence initial={false}><Panel key={identity}>{children}</Panel></AnimatePresence></div>;
}
