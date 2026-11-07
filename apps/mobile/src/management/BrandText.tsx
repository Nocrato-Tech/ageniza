import { View } from 'react-native';
import { Field, Txt, colors } from '../product/ui';
import { brandGuides, readBrandFields, writeBrandField } from './brand-text';

export function BrandText({ section, body, onChange }: { section: string; body: string; onChange?(body: string): void }) {
  const guide = brandGuides[section];
  if (!guide) return onChange ? <Field label="Observações" multiline value={body} onChangeText={onChange} style={{ minHeight: 140, textAlignVertical: 'top' }} /> : <Txt>{body || 'Registre orientações adicionais para a equipe.'}</Txt>;
  const values = readBrandFields(section, body);
  return <View style={{ gap: 16 }}><Txt kind="small" color={colors.muted}>{guide.hint}</Txt>{guide.fields.map((field, index) => onChange ? <Field key={field.label} label={field.label} placeholder={field.placeholder} multiline value={values[index] ?? ''} onChangeText={(value) => onChange(writeBrandField(section, body, index, value))} style={{ minHeight: index === 0 ? 110 : 90, textAlignVertical: 'top' }} /> : values[index] ? <View key={field.label} style={{ gap: 4 }}><Txt kind="label" color={colors.muted}>{field.label}</Txt><Txt>{values[index]}</Txt></View> : null)}</View>;
}
