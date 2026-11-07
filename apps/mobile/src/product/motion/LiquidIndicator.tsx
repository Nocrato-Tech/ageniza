import type { ReactNode } from 'react';
import { View } from 'react-native';
import { usableRect } from './liquid-geometry';
import type { SelectionRect } from './liquid-geometry';

export type LiquidIndicatorProps = {
  target: SelectionRect | null;
  color: string;
  radius?: number;
  immediate?: boolean;
  revision?: string;
  layer?: number;
  children?: ReactNode;
};

export function LiquidIndicator({ target, color, radius = 12, layer = 0 }: LiquidIndicatorProps) {
  if (!usableRect(target)) return null;
  return <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ position: 'absolute', left: target.x, top: target.y, width: target.width, height: target.height, borderRadius: radius, backgroundColor: color, zIndex: layer }} />;
}
