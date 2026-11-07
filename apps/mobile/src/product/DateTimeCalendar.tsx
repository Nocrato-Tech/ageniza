import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Pressable, View } from 'react-native';
import { CalendarDaySchema } from '@ageniza/contracts';
import { ChevronLeft, ChevronRight } from './icons';
import { Action, IconButton, Txt, ui, useColors } from './ui';
import { LiquidIndicator } from './motion/LiquidIndicator';
import { MonthMotion } from './motion/MonthMotion';

const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const validDay = (value: string) => CalendarDaySchema.safeParse(value).success;
const dayLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

export function DateTimeCalendar({ value, onChange }: { value: string; onChange(value: string): void }) {
  const c = useColors();
  const [month, setMonth] = useState(() => (validDay(value) ? value : today()).slice(0, 7));
  const [width, setWidth] = useState(0);
  const [focus, setFocus] = useState('');
  const buttons = useRef(new Map<string, View>());
  useEffect(() => { if (validDay(value)) setMonth(value.slice(0, 7)); }, [value]);
  useEffect(() => { if (focus) buttons.current.get(focus)?.focus(); }, [focus, month]);
  const start = `${month}-01`;
  const first = (new Date(`${start}T12:00:00Z`).getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
  const days = Array.from({ length: first + count }, (_, index) => index < first ? null : `${month}-${String(index - first + 1).padStart(2, '0')}`);
  const selected = days.indexOf(value);
  const target = selected >= 0 && width > 0 ? { x: selected % 7 * width / 7, y: Math.floor(selected / 7) * 48, width: width / 7, height: 44 } : null;
  const moveMonth = (direction: number) => {
    const date = new Date(`${start}T12:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + direction);
    const next = isoDay(date);
    if (/^\d{4}-/.test(next)) setMonth(next.slice(0, 7));
  };
  const keyDay = (event: KeyboardEvent<HTMLElement>, date: string) => {
    const current = new Date(`${date}T12:00:00Z`);
    const weekday = (current.getUTCDay() + 6) % 7;
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -weekday, End: 6 - weekday }[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    current.setUTCDate(current.getUTCDate() + delta);
    const next = isoDay(current);
    if (!validDay(next)) return;
    setFocus(next);
    setMonth(next.slice(0, 7));
    onChange(next);
  };
  const title = new Date(`${start}T12:00:00Z`).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return <View style={{ gap: 12 }}>
    <View style={[ui.row, { justifyContent: 'space-between' }]}><IconButton label="Mês anterior" icon={ChevronLeft} onPress={() => moveMonth(-1)} /><View style={{ flex: 1 }}><MonthMotion identity={month} variant="title"><Txt kind="strong" center>{title.charAt(0).toUpperCase() + title.slice(1)}</Txt></MonthMotion></View><IconButton label="Próximo mês" icon={ChevronRight} onPress={() => moveMonth(1)} /></View>
    <View style={{ flexDirection: 'row' }}>{['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'].map((name) => <View key={name} style={{ width: `${100 / 7}%` }}><Txt kind="label" color={c.muted} center>{name}</Txt></View>)}</View>
    <MonthMotion identity={month}><View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 4 }}>
      {days.map((date, index) => <View key={date ?? index} style={{ width: `${100 / 7}%`, height: 44 }}>{date && <Pressable ref={(node) => { if (node) buttons.current.set(date, node); else buttons.current.delete(date); }} accessibilityRole="button" accessibilityLabel={dayLabel(date)} aria-pressed={date === value} tabIndex={date === value || selected < 0 && date === start ? 0 : -1} {...({ onKeyDown: (event: KeyboardEvent<HTMLElement>) => keyDay(event, date) } as object)} onPress={() => onChange(date)} style={{ flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: date === today() ? c.indigo : 'transparent', backgroundColor: !target && date === value ? c.indigo : 'transparent' }}><Txt kind="strong" color={!target && date === value ? c.surface : c.text}>{Number(date.slice(-2))}</Txt></Pressable>}</View>)}
      <LiquidIndicator target={target} color={c.indigo} revision={month}><View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 4 }}>{days.map((date, index) => <View key={date ?? index} style={{ width: `${100 / 7}%`, height: 44, alignItems: 'center', justifyContent: 'center' }}>{date && <Txt kind="strong" color={c.surface}>{Number(date.slice(-2))}</Txt>}</View>)}</View></LiquidIndicator>
    </View></MonthMotion>
    <Action plain label="Hoje" onPress={() => { const date = today(); setMonth(date.slice(0, 7)); onChange(date); }} />
  </View>;
}
