import { forwardRef, useId, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import type { TextInput, TextInputProps } from 'react-native';
import { HugeIcon } from '../product/HugeIcon';
import { Field, Txt, useColors } from '../product/ui';
import { PasswordGuidance } from './PasswordGuidance';
import { assessConfirmation, assessPassword } from './password-assessment';
import { passwordHint } from './validation';

type PasswordFieldProps = TextInputProps & { label: string; error?: string; hint?: string; newPassword?: boolean; confirmationFor?: string; 'aria-describedby'?: string };
export const PasswordField = forwardRef<TextInput, PasswordFieldProps>(function PasswordField({ label, hint, error, newPassword = false, confirmationFor, ...props }, forwardedRef) {
  const [visible, setVisible] = useState(false);
  const generatedId = useId();
  const id = props.nativeID ?? generatedId;
  const colors = useColors();
  const input = useRef<TextInput>(null);
  const confirmation = confirmationFor === undefined ? undefined : assessConfirmation(confirmationFor, props.value ?? '');
  const liveError = confirmation === 'different' ? 'As senhas precisam ser iguais.' : newPassword && assessPassword(props.value ?? '').excess ? passwordHint : undefined;
  const fieldError = error ?? liveError;
  const description = [props['aria-describedby'], newPassword ? `${id}-guidance` : '', confirmation ? `${id}-confirmation` : ''].filter(Boolean).join(' ') || undefined;
  return <View style={{ gap: 8 }}>
    <Field {...props} nativeID={id} error={fieldError} aria-describedby={description} hint={newPassword || fieldError === hint ? undefined : hint} label={label} secureTextEntry={!visible} ref={(value) => { input.current = value; if (typeof forwardedRef === 'function') forwardedRef(value); else if (forwardedRef) forwardedRef.current = value; }} trailing={<Pressable accessibilityRole="button" accessibilityLabel={`${visible ? 'Ocultar' : 'Mostrar'} ${label}`} aria-controls={id} aria-pressed={visible} disabled={props.editable === false} onPress={() => { setVisible((value) => !value); input.current?.focus(); }} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 12 }}><HugeIcon name={visible ? 'eye-off' : 'eye'} size={20} color={colors.indigo} trigger={visible} /></Pressable>} />
    {newPassword && <PasswordGuidance password={props.value ?? ''} nativeID={`${id}-guidance`} />}
    {confirmation && <View nativeID={`${id}-confirmation`} accessibilityLiveRegion="polite"><Txt kind="small" color={confirmation === 'match' ? colors.teal : colors.muted}>{confirmation === 'match' ? 'As senhas coincidem.' : confirmation === 'different' ? 'Confira os dois campos ou use o botão de mostrar senha.' : confirmation === 'incomplete' ? 'Continue digitando para repetir a senha inteira.' : 'Repita a senha exatamente como no campo acima.'}</Txt></View>}
  </View>;
});
