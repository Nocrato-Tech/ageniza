import { createElement, useId, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { ErrorText, Field, IconButton, Txt, useColors } from './ui';
import { CalendarDays, Clock } from './icons';
import { DateTimePicker } from './DateTimePicker';

export function EditorDateTime({ kind, value, error, onChange, label: suppliedLabel, editable = true }: { kind: 'date' | 'time'; value: string; error?: string; label?: string; editable?: boolean; onChange(value: string): void }) {
  const colors = useColors();
  const id = useId();
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const label = suppliedLabel ?? (kind === 'date' ? 'Data proposta *' : 'Horário');
  const format = kind === 'date' ? 'AAAA-MM-DD' : 'HH:MM';
  const nativeLabel = suppliedLabel ? suppliedLabel.includes(format) ? suppliedLabel : `${suppliedLabel} (${format})` : kind === 'date' ? 'Data proposta (AAAA-MM-DD) *' : 'Horário (HH:MM)';
  if (Platform.OS !== 'web') return <Field label={nativeLabel} error={error} value={value} editable={editable} placeholder={kind === 'date' ? '2026-11-24' : '18:00'} onChangeText={onChange} />;
  const close = () => { setOpen(false); input.current?.focus(); };
  return <View style={{ gap: 8 }}><Txt kind="label" color={colors.muted}>{label}</Txt><View style={{ flexDirection: 'row', alignItems: 'center', borderRadius: 12, borderWidth: 1, borderColor: error ? colors.danger : colors.border, backgroundColor: colors.surface }}>
    {createElement('input', { ref: input, id, type: 'text', value, readOnly: !editable, placeholder: kind === 'date' ? 'AAAA-MM-DD' : 'HH:MM', 'aria-label': label, 'aria-invalid': !!error, 'aria-describedby': error ? `${id}-error` : undefined, 'aria-haspopup': 'dialog', 'aria-expanded': open, onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => { if (editable && event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); } }, onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value), style: { flex: 1, minWidth: 0, boxSizing: 'border-box', minHeight: 48, padding: 12, borderRadius: 12, border: 0, backgroundColor: 'transparent', color: colors.text, font: 'inherit', fontSize: 16 } })}
    {editable && <IconButton label={kind === 'date' ? 'Abrir calendário' : 'Escolher horário'} icon={kind === 'date' ? CalendarDays : Clock} onPress={() => setOpen(true)} />}
  </View>{error && <View nativeID={`${id}-error`}><ErrorText text={error} /></View>}
    <DateTimePicker open={open && editable} kind={kind} value={value} label={label} onClose={close} onApply={(next) => { onChange(next); close(); }} />
  </View>;
}
