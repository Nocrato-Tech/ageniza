import type { KeyboardEvent } from 'react';
import { createElement, useId, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import type { BrandColor } from '@ageniza/contracts';
import { BrandColorSchema } from '@ageniza/contracts';
import { Action, Field, Txt, colors, ui } from '../product/ui';
import { navigateSelection } from '../product/SelectionMotion';
import { Touch } from '../product/motion';
import { Disclosure } from '../product/Disclosure';
import { FlowList } from '../product/FlowList';

const swatches = ['#111827', '#64748B', '#E8ECF4', '#FFFFFF', '#4F46E5', '#7C3AED', '#14B8A6', '#0D9488', '#2563EB', '#0891B2', '#15803D', '#65A30D', '#CA8A04', '#EA580C', '#DC2626', '#DB2777'];
export function BrandPalette({ value, onChange }: { value: BrandColor[]; onChange?(value: BrandColor[]): void }) {
  const prefix = useId();
  const counter = useRef(value.length);
  const [keys, setKeys] = useState(() => value.map((_, index) => `${prefix}-${index}`));
  return <View style={{ gap: 16 }}>{!value.length && <Txt kind="small" color={colors.muted}>{onChange ? 'Adicione as cores da marca. Escolha uma amostra ou informe o hexadecimal exato.' : 'A paleta da marca ainda não foi definida.'}</Txt>}
    <FlowList items={value.map((color, index) => ({ id: keys[index] ?? `${prefix}-${index}`, color, index }))} renderItem={({ id, color, index }) => <ColorRow key={id} color={color} index={index} onChange={onChange ? (next) => onChange(value.map((item, i) => i === index ? next : item)) : undefined} onRemove={onChange ? () => { setKeys((items) => items.filter((_, i) => i !== index)); onChange(value.filter((_, i) => i !== index)); } : undefined} />} />
    {onChange && <Action soft label="Adicionar cor" disabled={value.length >= 24} onPress={() => { setKeys((items) => [...items, `${prefix}-${counter.current++}`]); onChange([...value, { name: '', hex: '#4F46E5' }]); }} />}
    {onChange && <Txt kind="micro" color={colors.muted}>{value.length} / 24 cores · As alterações são aplicadas ao salvar a seção.</Txt>}
  </View>;
}

function ColorRow({ color, index, onChange, onRemove }: { color: BrandColor; index: number; onChange?(value: BrandColor): void; onRemove?(): void }) {
  const [open, setOpen] = useState(false);
  const group = useId();
  const validHex = /^#[0-9a-f]{6}$/i.test(color.hex);
  const valid = BrandColorSchema.safeParse(color).success;
  return <View style={{ gap: 12, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 16 }}>
    <View style={[ui.row, { alignItems: 'center' }]}><View accessibilityLabel={validHex ? `Amostra ${color.name || index + 1}: ${color.hex}` : 'Cor inválida'} style={{ width: 64, height: 64, borderRadius: 12, backgroundColor: validHex ? color.hex : colors.soft, borderWidth: 1, borderColor: colors.border }} /><View style={{ flex: 1, gap: 4 }}><Txt kind="strong">{color.name || `Cor ${index + 1}`}</Txt><Txt kind="small" color={colors.muted}>{color.hex.toUpperCase()}</Txt></View></View>
    {onChange && <><Field label={`Nome da cor ${index + 1}`} value={color.name} placeholder="Ex.: Primária, fundo, destaque" maxLength={60} onChangeText={(name) => onChange({ ...color, name })} /><Field label={`Hexadecimal da cor ${index + 1}`} value={color.hex} maxLength={7} autoCapitalize="characters" autoCorrect={false} error={validHex ? undefined : 'Use # e seis caracteres de 0 a 9 ou A a F.'} onChangeText={(hex) => onChange({ ...color, hex })} /><Action soft label={`${open ? 'Fechar' : 'Escolher'} amostras da cor ${index + 1}`} onPress={() => setOpen(!open)} /><Disclosure open={open}><View accessibilityRole="radiogroup" accessibilityLabel={`Amostras da cor ${index + 1}`} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{swatches.map((hex) => <Touch key={hex} accessibilityRole="radio" accessibilityLabel={`Selecionar ${hex} na cor ${index + 1}`} accessibilityState={{ checked: color.hex.toUpperCase() === hex }} tabIndex={color.hex.toUpperCase() === hex || !swatches.includes(color.hex.toUpperCase()) && hex===swatches[0] ? 0 : -1} {...({onKeyDown:(event:KeyboardEvent<HTMLElement>)=>navigateSelection(event,swatches,hex,(next)=>onChange({...color,hex:next}))} as object)} onPress={() => onChange({ ...color, hex })} style={{ width: 44, height: 44, padding: 3, borderRadius: 12, borderWidth: 2, borderColor: color.hex.toUpperCase() === hex ? colors.indigo : colors.border }}><View nativeID={`${group}-${hex.slice(1)}`} style={{ flex: 1, borderRadius: 7, backgroundColor: hex }} /></Touch>)}</View><ColorChannels value={validHex ? color.hex : '#4F46E5'} index={index} onChange={(hex) => onChange({ ...color, hex })} /></Disclosure>{!valid && !color.name.trim() && <Txt kind="small" color={colors.muted}>Dê um nome para identificar o uso desta cor.</Txt>}<Action plain label={`Retirar cor ${index + 1}`} onPress={onRemove!} /></>}
  </View>;
}

function ColorChannels({ value, index, onChange }: { value: string; index: number; onChange(value: string): void }) {
  if (Platform.OS !== 'web') return null;
  const channels = [1, 3, 5].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
  return <View style={{ gap: 8 }}>{['Vermelho', 'Verde', 'Azul'].map((name, channel) => <View key={name} style={{gap:4}}><Txt kind="label" color={colors.muted}>{name} · {channels[channel]}</Txt>{createElement('input', { type:'range', min:0, max:255, value:channels[channel], 'aria-label':`${name} da cor ${index + 1}`, onChange:(event:React.ChangeEvent<HTMLInputElement>)=>{ const next=[...channels];next[channel]=Number(event.target.value);onChange('#'+next.map((item)=>item.toString(16).padStart(2,'0')).join('').toUpperCase()); }, style:{width:'100%',minHeight:44,margin:0,accentColor:colors.indigo,cursor:'pointer'} })}</View>)}</View>;
}
