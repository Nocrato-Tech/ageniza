import { forwardRef, useId, useRef, useState } from 'react';
import { Pressable } from 'react-native';
import type { TextInput, TextInputProps } from 'react-native';
import { Eye, EyeOff } from 'lucide-react-native';
import { Field, useColors } from '../product/ui';

type PasswordFieldProps = TextInputProps & { label: string; error?: string; hint?: string };
export const PasswordField = forwardRef<TextInput, PasswordFieldProps>(function PasswordField({ label, hint, ...props }, forwardedRef) {
  const [visible, setVisible] = useState(false);
  const generatedId = useId();
  const id = props.nativeID ?? generatedId;
  const colors = useColors();
  const Icon = visible ? EyeOff : Eye;
  const input = useRef<TextInput>(null);
  return <Field {...props} nativeID={id} hint={props.error === hint ? undefined : hint} label={label} secureTextEntry={!visible} ref={(value) => { input.current = value; if (typeof forwardedRef === 'function') forwardedRef(value); else if (forwardedRef) forwardedRef.current = value; }} trailing={<Pressable accessibilityRole="button" accessibilityLabel={`${visible ? 'Ocultar' : 'Mostrar'} ${label}`} aria-controls={id} aria-pressed={visible} disabled={props.editable === false} onPress={() => { setVisible((value) => !value); input.current?.focus(); }} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 12 }}><Icon size={20} color={colors.indigo} /></Pressable>} />;
});
