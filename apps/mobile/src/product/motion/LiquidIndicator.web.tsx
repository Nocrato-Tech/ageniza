import { useLayoutEffect, useRef } from 'react';
import { motion, useMotionValue, useSpring, useTransform } from 'motion/react';
import { useReducedMotion } from '../motion';
import type { LiquidIndicatorProps } from './LiquidIndicator';
import { liquidRect, usableRect } from './liquid-geometry';
import { motionTokens } from './tokens';

export function LiquidIndicator({ target, color, radius = 12, immediate = false, revision, layer = 1, children }: LiquidIndicatorProps) {
  const reduced = useReducedMotion();
  const valid = usableRect(target);
  const initialX = valid ? target.x + target.width / 2 : 0;
  const initialY = valid ? target.y + target.height / 2 : 0;
  const leadX = useSpring(initialX, motionTokens.spring.lead);
  const leadY = useSpring(initialY, motionTokens.spring.lead);
  const trailX = useSpring(initialX, motionTokens.spring.trail);
  const trailY = useSpring(initialY, motionTokens.spring.trail);
  const width = useMotionValue(valid ? target.width : 1);
  const height = useMotionValue(valid ? target.height : 1);
  const previous = useRef<{ revision?: string; width: number; height: number } | null>(null);

  const bounds = useTransform(() => liquidRect({ x: leadX.get(), y: leadY.get() }, { x: trailX.get(), y: trailY.get() }, { width: width.get(), height: height.get() }));
  const transform = useTransform(() => {
    const box = bounds.get();
    return `translate3d(${box.x}px, ${box.y}px, 0) scale(${box.width / width.get()}, ${box.height / height.get()})`;
  });
  const clipPath = useTransform(() => {
    const box = bounds.get();
    const rx = radius * box.width / width.get();
    const ry = radius * box.height / height.get();
    return `inset(${box.y}px calc(100% - ${box.x + box.width}px) calc(100% - ${box.y + box.height}px) ${box.x}px round ${rx}px / ${ry}px)`;
  });

  // Derived values must subscribe before a resize/reduced-motion jump publishes.
  useLayoutEffect(() => {
    if (!valid || !target) { previous.current = null; return; }
    const old = previous.current;
    const snap = reduced || immediate || !old || old.revision !== revision || Math.abs(old.width - target.width) > 1 || Math.abs(old.height - target.height) > 1;
    width.set(target.width);
    height.set(target.height);
    const x = target.x + target.width / 2;
    const y = target.y + target.height / 2;
    for (const [value, next] of [[leadX, x], [leadY, y], [trailX, x], [trailY, y]] as const) {
      if (snap) value.jump(next); else value.set(next);
    }
    previous.current = { revision, width: target.width, height: target.height };
  }, [target?.x, target?.y, target?.width, target?.height, valid, reduced, immediate, revision, width, height, leadX, leadY, trailX, trailY]);

  if (!valid) return null;
  return <div aria-hidden="true" data-liquid-indicator="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: layer }}>
    <motion.div data-liquid-surface="true" style={{ position: 'absolute', left: 0, top: 0, width: target.width, height: target.height, backgroundColor: color, borderRadius: radius, transformOrigin: '0 0', transform }} />
    {children && <motion.div style={{ position: 'absolute', inset: 0, clipPath }}>{children}</motion.div>}
  </div>;
}
