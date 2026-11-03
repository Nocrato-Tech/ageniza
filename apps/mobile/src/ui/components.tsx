import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { TextInputProps } from 'react-native';
import { light, radius, space } from './theme';
import owl from '../../assets/owl.png';

export const ThemeContext = createContext(light);
export const useTheme = () => useContext(ThemeContext);
export function Copy({ children, title = false, muted = false }: { children: ReactNode; title?: boolean; muted?: boolean }) {
  const t = useTheme();
  return <Text selectable style={{ color: muted ? t.muted : t.text, fontFamily: title ? 'Archivo_700Bold' : 'Geist_400Regular', fontSize: title ? 22 : 14, lineHeight: title ? 28 : 21 }}>{children}</Text>;
}
export function Button({ label, onPress, secondary = false, busy = false, disabled = false }: { label: string; onPress(): void; secondary?: boolean; busy?: boolean; disabled?: boolean }) {
  const t = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: disabled || busy, busy }} disabled={disabled || busy} onPress={onPress}
    style={({ pressed }) => [styles.button, { backgroundColor: secondary ? t.surface : t.action, borderColor: t.border, borderWidth: secondary ? 1 : 0, opacity: disabled ? 0.5 : pressed ? 0.75 : 1 }]}>
    {busy ? <ActivityIndicator color={secondary ? t.text : t.onAction} /> : <Text style={{ color: secondary ? t.text : t.onAction, fontFamily: 'Geist_600SemiBold', fontSize: 14 }}>{label}</Text>}
  </Pressable>;
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const t = useTheme();
  return <View style={{ gap: space.sm }}><Copy>{label}</Copy><TextInput accessibilityLabel={label} placeholderTextColor={t.muted} {...props}
    style={[styles.field, { color: t.text, backgroundColor: t.surface, borderColor: t.border }, props.style]} /></View>;
}
export function Notice({ message }: { message: string }) {
  const t = useTheme();
  return <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: t.danger, fontFamily: 'Geist_400Regular', fontSize: 14, lineHeight: 21 }}>{message}</Text>;
}
export function Empty({ title, body, onRetry }: { title: string; body: string; onRetry(): void }) {
  return <View style={{ gap: space.lg, alignItems: 'center', paddingVertical: space.xxl }}>
    <Image source={owl} style={{ width: 120, height: 120 }} resizeMode="contain" accessibilityIgnoresInvertColors />
    <Copy title>{title}</Copy><Copy muted>{body}</Copy><Button label="Atualizar" secondary onPress={onRetry} />
  </View>;
}
export const styles = StyleSheet.create({
  page: { flex: 1 }, body: { padding: space.xl, gap: space.xl, flexGrow: 1, width: '100%', maxWidth: 560, alignSelf: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  button: { minHeight: space.control, paddingHorizontal: space.lg, borderRadius: radius.field, alignItems: 'center', justifyContent: 'center' },
  field: { minHeight: space.control, borderWidth: 1, borderRadius: radius.field, padding: space.md, fontFamily: 'Geist_400Regular', fontSize: 16 },
  card: { padding: space.lg, gap: space.sm, borderRadius: radius.card, borderWidth: 1 },
  divider: { borderBottomWidth: 1, paddingBottom: space.lg, gap: space.md }
});
