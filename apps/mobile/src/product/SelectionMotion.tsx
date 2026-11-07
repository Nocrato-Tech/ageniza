import { useCallback, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { LayoutChangeEvent, LayoutRectangle } from 'react-native';

export function useSelectionMotion(value: string) {
  const [frames, setFrames] = useState<Record<string, LayoutRectangle>>({});
  const [immediate, setImmediate] = useState(false);
  const measure = useCallback((id: string, event: LayoutChangeEvent) => {
    const frame = event.nativeEvent.layout;
    setFrames((previous) => {
      const old = previous[id];
      return old && old.x === frame.x && old.y === frame.y && old.width === frame.width && old.height === frame.height
        ? previous : { ...previous, [id]: frame };
    });
  }, []);
  return {
    target: frames[value] ?? null,
    measure,
    immediate,
    inputHandlers: {
      onKeyDownCapture: () => setImmediate(true),
      onPointerDownCapture: () => setImmediate(false),
    },
  };
}

export function navigateSelection<T extends string>(event: KeyboardEvent<HTMLElement>, ids: T[], current: T, onChange: (id: T) => void) {
  const index = ids.indexOf(current);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1
    : event.key === 'ArrowRight' ? (index + 1) % ids.length
      : event.key === 'ArrowLeft' ? (index - 1 + ids.length) % ids.length : -1;
  if (next < 0 || !ids[next]) return;
  event.preventDefault();
  event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  onChange(ids[next]);
}
