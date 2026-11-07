import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { CalendarDaySchema } from '@ageniza/contracts';
import { Action, Field, IconButton, Txt, ui, useColors } from './ui';
import { OverlayMotion } from './OverlayMotion';
import { X } from './icons';
import { DateTimeCalendar } from './DateTimeCalendar';
import { DateTimeClock } from './DateTimeClock';

export function validDateTime(kind: 'date' | 'time', value: string) {
  return value === '' || (kind === 'date' ? CalendarDaySchema.safeParse(value).success : /^([01]\d|2[0-3]):[0-5]\d$/.test(value));
}

export function DateTimePicker({ open, kind, value, label, onClose, onApply }: { open: boolean; kind: 'date' | 'time'; value: string; label: string; onClose(): void; onApply(value: string): void }) {
  const c = useColors();
  const [draft, setDraft] = useState(value);
  const [attempted, setAttempted] = useState(false);
  useEffect(() => { if (open) { setDraft(value); setAttempted(false); } }, [open, value]);
  const valid = validDateTime(kind, draft);
  return <OverlayMotion open={open} onClose={onClose} placement="center" style={{ width: '100%', maxWidth: 460, maxHeight: '90%', backgroundColor: c.canvas, borderRadius: 24, padding: 20, gap: 16 }}>
    <View style={[ui.row, { justifyContent: 'space-between' }]}><View style={{ flex: 1 }}><Txt kind="section">{label}</Txt></View><IconButton label="Cancelar seleção" icon={X} onPress={onClose} /></View>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 16 }}>
      <Field label={kind === 'date' ? 'Data (AAAA-MM-DD)' : 'Hora (HH:MM)'} value={draft} onChangeText={setDraft} error={attempted && !valid ? kind === 'date' ? 'Informe uma data válida no formato AAAA-MM-DD.' : 'Informe um horário válido no formato HH:MM.' : undefined} />
      {kind === 'date' ? <DateTimeCalendar value={draft} onChange={setDraft} /> : <DateTimeClock value={draft} onChange={setDraft} />}
    </ScrollView>
    <View style={{ gap: 8 }}><Action label={kind === 'date' ? 'Confirmar data' : 'Confirmar horário'} onPress={() => { setAttempted(true); if (valid) onApply(draft); }} /><View style={[ui.row, { justifyContent: 'space-between' }]}><Action plain label="Limpar" onPress={() => setDraft('')} /><Action plain label="Cancelar" onPress={onClose} /></View></View>
  </OverlayMotion>;
}
