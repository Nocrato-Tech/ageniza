import { useEffect, useRef } from 'react';
import { MotionConfig } from 'motion/react';
import { useReducedMotion } from './motion';
import { animatedIcons } from './icons/registry.web';
import type { HugeIconName } from './HugeIcon';
import type { AnimatedIconHandle } from './icons/upstream/use-icon-animation';

export type { HugeIconName } from './HugeIcon';
export function HugeIcon({ name, size = 22, color = 'currentColor', trigger = false, checked = true }: { name: HugeIconName; size?: number; color?: string; trigger?: boolean | number; checked?: boolean }) {
  const host = useRef<HTMLSpanElement>(null);
  const handle = useRef<AnimatedIconHandle>(null);
  const reduced = useReducedMotion();
  const Component = animatedIcons[name];
  useEffect(() => {
    const target = host.current?.closest('button, a, [role="button"], [role="tab"], [role="radio"]') ?? host.current;
    if (!target) return;
    if (reduced) { handle.current?.stopAnimation(); return; }
    const start = () => { if (!target.closest('[aria-disabled="true"], :disabled')) handle.current?.startAnimation(); };
    const stop = () => handle.current?.stopAnimation();
    target.addEventListener('pointerenter', start);
    target.addEventListener('pointerdown', start);
    target.addEventListener('click', start);
    target.addEventListener('focusin', start);
    return () => {
      target.removeEventListener('pointerenter', start);
      target.removeEventListener('pointerdown', start);
      target.removeEventListener('click', start);
      target.removeEventListener('focusin', start);
      stop();
    };
  }, [name, reduced]);
  useEffect(() => { if (!reduced && trigger !== false && trigger !== 0) handle.current?.startAnimation(); }, [name, trigger, reduced]);
  return <MotionConfig reducedMotion={reduced ? 'always' : 'never'}><span ref={host} data-hugeicon={name} data-pending={!checked || undefined} aria-hidden="true" style={{ color, width: size, height: size, display: 'inline-flex', flexShrink: 0, alignItems: 'center', justifyContent: 'center' }}>
    {!checked && <style>{'[data-hugeicon][data-pending] svg > :not(:first-child) { display: none; }'}</style>}
    <Component ref={handle} size={size} aria-hidden="true" />
  </span></MotionConfig>;
}
