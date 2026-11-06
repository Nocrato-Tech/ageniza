import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AccessibilityInfo, Animated, Easing, Platform, Pressable } from 'react-native';
import type { PressableProps, StyleProp, ViewStyle } from 'react-native';

export function useReducedMotion() {
  const [reduced, setReduced] = useState(true);
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

export function Touch({ children, style, onPressIn, onPressOut, ...props }: Omit<PressableProps, 'children' | 'style'> & { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(0)).current;
  const animate = (pressed: boolean) => {
    progress.stopAnimation();
    Animated.timing(progress, { toValue: pressed ? 1 : 0, duration: reduced ? 0 : pressed ? 80 : 150, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  };
  useEffect(() => () => progress.stopAnimation(), [progress]);
  return <AnimatedPressable {...props} onPressIn={(event) => { animate(true); onPressIn?.(event); }} onPressOut={(event) => { animate(false); onPressOut?.(event); }} style={[style, { opacity: progress.interpolate({ inputRange: [0, 1], outputRange: props.disabled ? [0.45, 0.45] : [1, 0.78] }), transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0.98] }) }] }]}>{children}</AnimatedPressable>;
}

export function ScreenMotion({ children, identity, fill = false, quiet = false }: { children: ReactNode; identity: string; fill?: boolean; quiet?: boolean }) {
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    progress.stopAnimation();
    if (reduced || quiet) { progress.setValue(1); return; }
    progress.setValue(0);
    const animation = Animated.timing(progress, { toValue: 1, duration: 190, easing: Easing.out(Easing.cubic), useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [identity, reduced, quiet, progress]);
  return <Animated.View style={{ flex: fill ? 1 : undefined, opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0.65, 1] }), transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] }}>{children}</Animated.View>;
}

