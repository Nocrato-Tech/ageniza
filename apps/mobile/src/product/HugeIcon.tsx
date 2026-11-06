import { View } from 'react-native';
import Svg, { Circle, Line, Path, Polyline, Rect } from 'react-native-svg';
import { geometry } from './icons/geometry';
export type HugeIconName = keyof typeof geometry;
// Metro uses HugeIcon.web for the original DOM/Motion animations.
export function HugeIcon({ name, size = 22, color = 'currentColor', checked = true }: { name: HugeIconName; size?: number; color?: string; trigger?: boolean | number; checked?: boolean }) {
  return <View accessible={false} pointerEvents="none" style={{ width: size, height: size }}><Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {(checked ? geometry[name] : geometry[name].slice(0, 1)).map((shape, index) => {
      const Component = ({ path: Path, circle: Circle, line: Line, polyline: Polyline, rect: Rect } as const)[shape.tag];
      return <Component key={index} {...shape.attrs} />;
    })}
  </Svg></View>;
}
