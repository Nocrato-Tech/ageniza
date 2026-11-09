import type { KeyboardEvent } from 'react';
import { useEffect, useId, useRef } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { Txt, useColors } from './ui';
import { Touch } from './motion';
import { ClockHighlight } from './ClockHighlight';

function ClockColumn({ label, count, value, onChange }: { label: string; count: number; value: string; onChange(value: string): void }) {
  const c = useColors();
  const selected = useRef<View>(null);
  const group = useId();
  useEffect(() => { (selected.current as unknown as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest' }); }, [value]);
  return <View style={{ flex: 1, gap: 8 }}><Txt kind="label" color={c.muted} center>{label}</Txt><ScrollView style={{ height: 220, borderWidth: 1, borderColor: c.border, borderRadius: 16, backgroundColor: c.surface }}>
    <View {...({ role: 'listbox' } as object)} aria-label={label}>
      {Array.from({ length: count }, (_, index) => String(index).padStart(2, '0')).map((item) => <Pressable key={item} ref={item === value ? selected : undefined} role="option" aria-selected={item === value} accessibilityLabel={`${label}: ${item}`} tabIndex={item === value ? 0 : -1} onPress={() => onChange(item)} {...({ onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        const index = Number(item);
        const next = event.key === 'ArrowDown' ? (index + 1) % count : event.key === 'ArrowUp' ? (index + count - 1) % count : event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : -1;
        if (next < 0) return;
        event.preventDefault();
        onChange(String(next).padStart(2, '0'));
        event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="option"]')[next]?.focus();
      } } as object)} style={{ minHeight: 44, margin: 4, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: Platform.OS !== 'web' && item === value ? c.soft : 'transparent' }}><ClockHighlight active={item === value} group={group} color={c.soft} border={c.indigo} /><Txt kind="strong" color={c.text}>{item}</Txt></Pressable>)}
    </View>
  </ScrollView></View>;
}

export function DateTimeClock({ value, onChange }: { value: string; onChange(value: string): void }) {
  const c = useColors();
  const valid = /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  const [hours, minutes] = valid ? value.split(':') : ['09', '00'];
  return <View style={{ gap: 16 }}><View style={{ flexDirection: 'row', gap: 16 }}><ClockColumn label="Horas" count={24} value={hours!} onChange={(hour) => onChange(`${hour}:${minutes}`)} /><ClockColumn label="Minutos" count={60} value={minutes!} onChange={(minute) => onChange(`${hours}:${minute}`)} /></View><View style={{ flexDirection: 'row', gap: 8 }}>{['00', '15', '30', '45'].map((minute) => <Touch key={minute} accessibilityRole="button" accessibilityLabel={`Minutos ${minute}`} onPress={() => onChange(`${hours}:${minute}`)} style={{ flex: 1, minHeight: 44, borderRadius: 12, backgroundColor: c.soft, justifyContent: 'center', alignItems: 'center' }}><Txt kind="label" color={c.indigo}>:{minute}</Txt></Touch>)}</View></View>;
}
