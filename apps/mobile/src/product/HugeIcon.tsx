import { useEffect, useRef } from 'react';
import { Platform, View } from 'react-native';
import Svg, { Circle, Line, Path, Polyline } from 'react-native-svg';
import { useReducedMotion } from './motion';
import { geometry } from './icons/geometry';

export type HugeIconName = keyof typeof geometry;
/** MIT Hugeicons geometry; finite interaction motion, never a loading indicator. */
export function HugeIcon({ name, size = 22, color = 'currentColor', trigger = false }: { name: HugeIconName; size?: number; color?: string; trigger?: boolean | number }) {
  const ref = useRef<View>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    if (Platform.OS !== 'web' || reduced || trigger === false || trigger === 0) return;
    const host = ref.current as unknown as HTMLElement | null;
    const svg = host?.querySelector?.('svg');
    if (!svg || typeof svg.animate !== 'function') return;
    const bell = name === 'notification-03';
    const upload = name === 'cloud-upload';
    const eye = name === 'eye' || name === 'eye-off';
    svg.style.transformOrigin = bell ? '50% 10%' : '50% 50%';
    const frames = bell ? [0, -14, 11, -8, 5, 0].map(angle => ({ transform: `rotate(${angle}deg)` }))
      : eye ? [{ transform: 'scaleY(1)' }, { transform: 'scaleY(.3)' }, { transform: 'scaleY(1)' }]
      : upload ? [{ transform: 'translateY(0)' }, { transform: 'translateY(-3px)' }, { transform: 'translateY(0)' }]
      : [{ transform: 'scale(1)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }];
    const animation = svg.animate(frames, { duration: bell ? 650 : 320, easing: 'ease-in-out', iterations: 1 });
    return () => animation.cancel();
  }, [name, trigger, reduced]);
  return <View ref={ref} accessible={false} pointerEvents="none" style={{ width: size, height: size }}><Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {geometry[name].map((shape, index) => {
      const Component = ({ path: Path, circle: Circle, line: Line, polyline: Polyline } as const)[shape.tag];
      return <Component key={index} {...shape.attrs} />;
    })}
  </Svg></View>;
}
