import { createElement, useId } from 'react';
import { Platform, View } from 'react-native';
import { ErrorText, Field, Txt, useColors } from './ui';

export function EditorDateTime({ kind, value, error, onChange, label: suppliedLabel }: { kind: 'date' | 'time'; value: string; error?: string; label?: string; onChange(value: string): void }) {
  const colors = useColors();
  const id = useId();
  const label = suppliedLabel ?? (kind === 'date' ? 'Data proposta *' : 'Horário');
  if (Platform.OS !== 'web') return <Field label={suppliedLabel ? `${suppliedLabel} (${kind === 'date' ? 'AAAA-MM-DD' : 'HH:MM'})` : kind === 'date' ? 'Data proposta (AAAA-MM-DD) *' : 'Horário (HH:MM)'} error={error} value={value} placeholder={kind === 'date' ? '2026-11-24' : '18:00'} onChangeText={onChange} />;
  return <View style={{ gap: 8 }}><Txt kind="label" color={colors.muted}>{label}</Txt>{createElement('input', { id, type: kind, value, 'aria-label': label, 'aria-invalid': !!error, 'aria-describedby': error ? `${id}-error` : undefined, onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value), style: { width: '100%', boxSizing: 'border-box', minHeight: 48, padding: 12, borderRadius: 12, border: `1px solid ${error ? colors.danger : colors.border}`, backgroundColor: colors.surface, color: colors.text, font: 'inherit', fontSize: 16 } })}{error && <View nativeID={`${id}-error`}><ErrorText text={error} /></View>}</View>;
}
