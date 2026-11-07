import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Animated, Easing, Modal, Platform, StyleSheet, View } from 'react-native';
import type { ViewStyle } from 'react-native';
import { useReducedMotion } from './motion';
import { motionTokens } from './motion/tokens';

export function OverlayMotion({ open, onClose, children, style, placement = 'bottom' }: { open: boolean; onClose(): void; children: ReactNode; style?: ViewStyle; placement?: 'bottom' | 'center' }) {
  const reduced = useReducedMotion();
  const [present, setPresent] = useState(open);
  const [height, setHeight] = useState(0);
  const progress = useRef(new Animated.Value(0)).current;
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    if (open) setPresent(true);
    progress.stopAnimation();
    if (reduced) {
      progress.setValue(open ? 1 : 0);
      if (!open) setPresent(false);
      return;
    }
    if (!height) {
      if (!open) setPresent(false);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: open ? 1 : 0,
      duration: open ? motionTokens.slow : motionTokens.base,
      easing: Easing.bezier(...motionTokens.ease),
      useNativeDriver: Platform.OS !== 'web',
    });
    animation.start(({ finished }) => { if (finished && !openRef.current) setPresent(false); });
    return () => animation.stop();
  }, [open, reduced, height, progress]);

  return <Modal visible={open || present} transparent animationType="none" onRequestClose={onClose}>
    <View style={{ flex: 1, justifyContent: placement === 'center' ? 'center' : 'flex-end', alignItems: placement === 'center' ? 'center' : undefined, paddingHorizontal: placement === 'center' ? 20 : 0 }}>
      <Animated.View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[StyleSheet.absoluteFill, { backgroundColor: '#11182788', opacity: progress }]} />
      <Animated.View ref={(node) => { if (Platform.OS === 'web' && node) (node as unknown as HTMLElement).inert = !open; }} accessibilityViewIsModal accessibilityElementsHidden={!open} importantForAccessibility={open ? 'auto' : 'no-hide-descendants'} aria-hidden={!open} pointerEvents={open ? 'auto' : 'none'} onLayout={(event) => setHeight(event.nativeEvent.layout.height)} style={[style, {
        opacity: placement === 'center' && !reduced ? progress : height || reduced ? 1 : 0,
        transform: [{ translateY: reduced ? 0 : progress.interpolate({ inputRange: [0, 1], outputRange: [placement === 'center' ? 8 : height, 0] }) }, { scale: reduced || placement === 'bottom' ? 1 : progress.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) }],
      }]}>{children}</Animated.View>
    </View>
  </Modal>;
}
