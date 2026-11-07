import type { ReactNode } from 'react';
import { View } from 'react-native';

export type MonthMotionProps = { identity: string; children: ReactNode; variant?: 'grid' | 'title' };

export function MonthMotion({ children }: MonthMotionProps) {
  return <View style={{ minWidth: 0 }}>{children}</View>;
}
