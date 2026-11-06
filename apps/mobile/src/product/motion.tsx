import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AccessibilityInfo, Animated, Easing, Platform, Pressable, View } from 'react-native';
import type { PressableProps, StyleProp, ViewStyle } from 'react-native';

// Mirrors docs/design-system.md §12 across the web and native renderers.
const motion = { fast: 120, base: 180, slow: 240, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' };
const nativeEasing = Easing.bezier(0.16, 1, 0.3, 1);

export function useReducedMotion() {
  const [reduced, setReduced] = useState(() => Platform.OS === 'web' && typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : true);
  useEffect(() => {
    if (Platform.OS === 'web' && typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const media = window.matchMedia('(prefers-reduced-motion: reduce)');
      const update = () => setReduced(media.matches);
      update(); media.addEventListener('change', update);
      return () => media.removeEventListener('change', update);
    }
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (active) setReduced(value); }).catch(() => {});
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => { active = false; subscription?.remove(); };
  }, []);
  return reduced;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type TouchProps = Omit<PressableProps, 'children' | 'style'> & { children: ReactNode; style?: StyleProp<ViewStyle> };

export function Touch(props: TouchProps) {
  return Platform.OS === 'web' ? <WebTouch {...props} /> : <NativeTouch {...props} />;
}

function WebTouch({ children, style, ...props }: TouchProps) {
  const reduced = useReducedMotion();
  const transition = { transitionProperty: 'transform, opacity', transitionDuration: reduced ? '0ms' : `${motion.fast}ms`, transitionTimingFunction: motion.easing } as ViewStyle;
  return <Pressable {...props} style={({ pressed }) => [style, transition, { opacity: props.disabled ? 0.45 : pressed ? 0.85 : 1, transform: [{ scale: pressed && !reduced && !props.disabled ? 0.98 : 1 }] }]}>{children}</Pressable>;
}

function NativeTouch({ children, style, onPressIn, onPressOut, ...props }: TouchProps) {
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(0)).current;
  const animate = (pressed: boolean) => {
    progress.stopAnimation();
    Animated.timing(progress, { toValue: pressed ? 1 : 0, duration: reduced ? 0 : motion.fast, easing: nativeEasing, useNativeDriver: true }).start();
  };
  useEffect(() => { if (reduced) { progress.stopAnimation(); progress.setValue(0); } }, [reduced, progress]);
  useEffect(() => () => progress.stopAnimation(), [progress]);
  return <AnimatedPressable {...props} onPressIn={(event) => { animate(true); onPressIn?.(event); }} onPressOut={(event) => { animate(false); onPressOut?.(event); }} style={[style, { opacity: progress.interpolate({ inputRange: [0, 1], outputRange: props.disabled ? [0.45, 0.45] : [1, 0.78] }), transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0.98] }) }] }]}>{children}</AnimatedPressable>;
}

export type MotionDirection = 'forward' | 'back';
type ScreenMotionProps = { children: ReactNode; identity: string; fill?: boolean; quiet?: boolean; variant?: 'page' | 'peer' | 'step' | 'feedback'; direction?: MotionDirection };

export function ScreenMotion(props: ScreenMotionProps) {
  return Platform.OS === 'web' ? <WebScreenMotion {...props} /> : <NativeScreenMotion {...props} />;
}

function arrival(variant: NonNullable<ScreenMotionProps['variant']>, direction: MotionDirection) {
  const sign = direction === 'back' ? -1 : 1;
  return { x: variant === 'page' ? sign * 16 : variant === 'step' ? sign * 8 : 0, y: variant === 'feedback' ? -8 : 0, opacity: variant === 'peer' ? 0.5 : 0.35, duration: variant === 'peer' ? motion.fast : variant === 'page' ? motion.slow : motion.base };
}

function WebScreenMotion({ children, identity, fill = false, quiet = false, variant = 'page', direction = 'forward' }: ScreenMotionProps) {
  const reduced = useReducedMotion();
  const element = useRef<View>(null);
  const previous = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const changed = previous.current !== identity;
    previous.current = identity;
    if (reduced || quiet || !changed) return;
    const node = element.current as unknown as HTMLElement | null;
    if (!node || typeof node.animate !== 'function') return;
    const from = arrival(variant, direction);
    const animation = node.animate([{ opacity: from.opacity, transform: `translate3d(${from.x}px, ${from.y}px, 0)` }, { opacity: 1, transform: 'translate3d(0, 0, 0)' }], { duration: from.duration, easing: motion.easing });
    return () => animation.cancel();
  }, [identity, reduced, quiet, variant, direction]);
  return <View ref={element} {...({ dataSet: { motion: variant, motionDirection: direction } } as object)} style={{ flex: fill ? 1 : undefined, minHeight: fill ? 0 : undefined }}>{children}</View>;
}

function NativeScreenMotion({ children, identity, fill = false, quiet = false, variant = 'page', direction = 'forward' }: ScreenMotionProps) {
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(1)).current;
  const previous = useRef<string | undefined>(undefined);
  const from = arrival(variant, direction);
  useEffect(() => {
    progress.stopAnimation();
    const changed = previous.current !== identity;
    previous.current = identity;
    if (reduced || quiet || !changed) { progress.setValue(1); return; }
    progress.setValue(0);
    const animation = Animated.timing(progress, { toValue: 1, duration: from.duration, easing: nativeEasing, useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [identity, reduced, quiet, progress, from.duration]);
  return <Animated.View style={{ flex: fill ? 1 : undefined, opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [from.opacity, 1] }), transform: [{ translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [from.x, 0] }) }, { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [from.y, 0] }) }] }}>{children}</Animated.View>;
}

