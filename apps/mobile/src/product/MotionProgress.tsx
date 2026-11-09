import { View } from 'react-native';
export function MotionProgress({ value, color }: { value: number; color: string }) {
  return <View style={{ height: '100%', width: `${Math.max(0, Math.min(1, value)) * 100}%`, backgroundColor: color, borderRadius: 4 }} />;
}
