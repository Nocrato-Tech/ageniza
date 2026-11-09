import type { KeyboardEvent } from 'react';
import { View } from 'react-native';
import { ARCHETYPE_LABELS, ArchetypeSchema } from '@ageniza/contracts';
import { navigateSelection } from '../product/SelectionMotion';
import { Touch } from '../product/motion';
import { Txt, colors } from '../product/ui';
const descriptions: Record<string, string> = { innocent:'Simplicidade e otimismo', sage:'Conhecimento e clareza', explorer:'Liberdade e descobertas', outlaw:'Ruptura e transformação', magician:'Possibilidades e mudança', hero:'Superação e coragem', lover:'Conexão e sensibilidade', jester:'Leveza e espontaneidade', everyman:'Proximidade e pertencimento', caregiver:'Cuidado e acolhimento', ruler:'Confiança e liderança', creator:'Criatividade e expressão' };
export function BrandArchetype({ value, onChange }: { value: string; onChange(value: string): void }) {
 return <View style={{gap:12}}><Txt kind="small" color={colors.muted}>Escolha a personalidade que orienta as decisões e a comunicação da marca.</Txt><View accessibilityRole="radiogroup" accessibilityLabel="Arquétipo" style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>{ArchetypeSchema.options.map((id)=><Touch key={id} accessibilityRole="radio" accessibilityLabel={ARCHETYPE_LABELS[id]} accessibilityState={{checked:value===id}} tabIndex={value===id || !value && id===ArchetypeSchema.options[0] ? 0 : -1} {...({onKeyDown:(event:KeyboardEvent<HTMLElement>)=>navigateSelection(event,ArchetypeSchema.options,id,onChange)} as object)} onPress={()=>onChange(id)} style={{width:'48%',minHeight:88,padding:12,gap:4,borderRadius:12,borderWidth:1,borderColor:value===id?colors.indigo:colors.border,backgroundColor:value===id?colors.soft:colors.surface}}><Txt kind="strong" color={value===id?colors.indigo:colors.text}>{ARCHETYPE_LABELS[id]}</Txt><Txt kind="small" color={colors.muted}>{descriptions[id]}</Txt></Touch>)}</View></View>;
}
