import type { ReactNode } from 'react';
import { View } from 'react-native';

export function FlowList<T extends { id: string }>({ items, renderItem }: { items: T[]; renderItem(item: T): ReactNode }) {
  return <View style={{ gap: 16 }}>{items.map(renderItem)}</View>;
}
