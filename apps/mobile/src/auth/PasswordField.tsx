import { forwardRef, useRef, useState } from 'react';
import { View } from 'react-native';
import type { TextInput, TextInputProps } from 'react-native';
import { Action, Field } from '../product/ui';

type PasswordFieldProps = TextInputProps & { label: string; error?: string; hint?: string };
export const PasswordField = forwardRef<TextInput, PasswordFieldProps>(function PasswordField({ label, hint, ...props }, forwardedRef) {
  const [visible, setVisible] = useState(false);
  const input = useRef<TextInput>(null);
  return <View><Field {...props} hint={props.error === hint ? undefined : hint} label={label} secureTextEntry={!visible} ref={(value) => { input.current = value; if (typeof forwardedRef === 'function') forwardedRef(value); else if (forwardedRef) forwardedRef.current = value; }} /><Action plain label={`${visible ? 'Ocultar' : 'Mostrar'} ${label}`} disabled={props.editable === false} onPress={() => { setVisible((value) => !value); input.current?.focus(); }} /></View>;
});

