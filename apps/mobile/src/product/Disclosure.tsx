import type { ReactNode } from 'react';
import { View } from 'react-native';

export function Disclosure({ open, children }: { open: boolean; children: ReactNode }) {
  return open ? <View style={{ gap: 16 }}>{children}</View> : null;
}
