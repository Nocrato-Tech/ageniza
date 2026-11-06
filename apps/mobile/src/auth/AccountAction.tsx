import { acceptInvitation, invitationPreferredContext } from './invitation';
import type { TextInput } from 'react-native';
import { PasswordField } from './PasswordField';
import { passwordHint, validateCredentials } from './validation';
import type { AuthErrors, AuthField } from './validation';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, ScrollView, Switch, View } from 'react-native';
import { AuthPasswordResetRequestSchema, AuthEmailVerifyRequestSchema } from '@ageniza/contracts';
import type { InvitationPreviewResponse } from '@ageniza/contracts';
import { api, webUrl } from '../api/runtime';
import { ApiError } from '../api/client';
import { Action, Card, ErrorText, Field, Heading, Info, Txt, colors, ui } from '../product/ui';
import type { AccountLink } from './links';

export function TermsConsent({ accepted, onChange, disabled = false }: { accepted: boolean; onChange(value: boolean): void; disabled?: boolean }) {
  return <View style={{ gap: 8 }}><View style={ui.row}><Switch accessibilityLabel="Li e aceito os Termos de Uso e a Política de Privacidade" value={accepted} onValueChange={onChange} disabled={disabled} trackColor={{ true: colors.indigo }} /><View style={{ flex: 1 }}><Txt kind="small">Li e aceito os Termos de Uso e a Política de Privacidade.</Txt></View></View><View style={ui.row}><View style={{ flex: 1 }}><Action plain label="Termos de Uso" onPress={() => void Linking.openURL(`${webUrl}/termos`)} /></View><View style={{ flex: 1 }}><Action plain label="Privacidade" onPress={() => void Linking.openURL(`${webUrl}/privacidade`)} /></View></View></View>;
}

export function AccountAction({ link, onDone, onClose }: { link: AccountLink; onDone(preferred?: string): Promise<void>; onClose(): void }) {
  const [preview, setPreview] = useState<InvitationPreviewResponse>();
  const [loading, setLoading] = useState(link.kind === 'invitation');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [continuation, setContinuation] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const pending = useRef(false);
  const [fieldErrors, setFieldErrors] = useState<AuthErrors>({});
  const inputs = useRef<Partial<Record<AuthField, TextInput | null>>>({});
  const change = (field: AuthField, update: (value: string) => void) => (value: string) => { update(value); setFieldErrors((current) => ({ ...current, [field]: undefined, ...(field === 'password' ? { confirm: undefined } : {}) })); };
  useEffect(() => {
    if (link.kind !== 'invitation') return;
    let active = true; setLoading(true); setError('');
    void api.request<InvitationPreviewResponse>(`/invitations/${encodeURIComponent(link.token)}`).then((value) => { if (active) setPreview(value); }).catch((cause: unknown) => { if (active) setError(cause instanceof ApiError && cause.status === 410 ? 'Este convite expirou ou já foi utilizado. Peça um novo à agência.' : 'Não foi possível carregar o convite. Tente novamente.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [link.kind, link.token, retry]);
  async function submit() {
    if (pending.current) return;
    const newAccount = link.kind === 'invitation' && !!preview && !preview.accountExists;
    const errors = link.kind === 'emailChange' || link.kind === 'verify' && !password ? {} : validateCredentials({ password, ...(link.kind === 'reset' ? { newPassword: true, confirm } : {}), ...(newAccount ? { newAccount: true, name, confirm, accepted } : {}) });
    setFieldErrors(errors);
    const first = Object.keys(errors)[0] as AuthField | undefined;
    if (first) { inputs.current[first]?.focus(); return; }
    pending.current = true; setBusy(true); setError('');
    try {
      if (link.kind === 'reset') {
        if (password !== confirm) throw new Error('As senhas precisam ser iguais.');
        const parsed = AuthPasswordResetRequestSchema.safeParse({ token: link.token, newPassword: password });
        if (!parsed.success) throw new Error('Use uma senha entre 10 e 128 caracteres.');
        await api.request('/auth/password/reset', { method: 'POST', body: parsed.data });
        await api.clearSession(); setPassword(''); setConfirm(''); setDone(true);
      } else if (link.kind === 'verify') {
        const parsed = AuthEmailVerifyRequestSchema.safeParse({ token: link.token, ...(password ? { password } : {}) });
        if (!parsed.success) throw new Error('Confira o link e sua senha.');
        await api.request('/auth/email/verify', { method: 'POST', body: parsed.data });
        setPassword(''); setContinuation(''); await onDone();
      } else if (link.kind === 'emailChange') {
        await api.request('/email-change/confirm', { method: 'POST', body: { token: link.token } });
        await api.clearSession(); setDone(true);
      } else if (preview) {
        const context = await acceptInvitation(api, link.token, preview, { name, password, confirmation: confirm, accepted });
        const preferred = invitationPreferredContext(context);
        setPassword(''); setConfirm(''); setContinuation(preferred); await onDone(preferred);
      }
    } catch (cause) { setError(cause instanceof ApiError && ['INVALID_LINK', 'INVALID_LINK_OR_PASSWORD'].includes(cause.code) ? 'O link expirou, já foi utilizado ou a senha está incorreta. Solicite um novo link se necessário.' : cause instanceof Error ? cause.message : 'Não foi possível concluir. Tente novamente.'); }
    finally { pending.current = false; setBusy(false); }
  }
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={ui.body}>
    <Heading title={link.kind === 'invitation' ? 'Seu próximo fluxo começa aqui.' : link.kind === 'verify' ? 'Confirme seu e-mail' : link.kind === 'reset' ? 'Crie uma nova senha' : 'Confirme seu novo e-mail'} />
    {continuation !== null ? <><Info title="Ação concluída" text="Sua confirmação foi registrada. Continue para carregar seus acessos, sem reutilizar o link." />{!!error && <ErrorText text={error} />}<Action label="Continuar para meus acessos" busy={busy} onPress={() => { if (pending.current) return; pending.current = true; setBusy(true); void onDone(continuation || undefined).catch(() => setError('Não foi possível carregar seus acessos. Confira a conexão e tente continuar novamente.')).finally(() => { pending.current = false; setBusy(false); }); }} /></> : done ? <><Info title={link.kind === 'reset' ? 'Senha atualizada' : 'E-mail confirmado'} text="Entre novamente para continuar. As sessões anteriores foram encerradas." /><Action label="Voltar para entrar" onPress={onClose} /></> : <>
      {preview && <Card><Txt kind="section">{preview.agency.name}</Txt>{preview.client && <Txt>Portal de {preview.client.name}</Txt>}<Txt color={colors.muted}>{preview.email}</Txt></Card>}
      {link.kind === 'invitation' && !preview ? <><Info title={loading ? 'Carregando convite…' : 'Convite indisponível'} />{!loading && <Action soft label="Tentar novamente" onPress={() => setRetry((value) => value + 1)} />}</> : <>
        {link.kind === 'invitation' && !preview?.accountExists && <Field ref={(value) => { inputs.current.name = value; }} error={fieldErrors.name} label="Seu nome" value={name} onChangeText={change('name', setName)} autoComplete="name" editable={!busy} />}
        {link.kind !== 'emailChange' && <PasswordField ref={(value) => { inputs.current.password = value; }} error={fieldErrors.password} hint={link.kind === 'reset' || link.kind === 'invitation' && !preview?.accountExists ? passwordHint : undefined} label={link.kind === 'reset' ? 'Nova senha' : 'Senha da sua conta'} value={password} onChangeText={change('password', setPassword)} autoComplete={link.kind === 'reset' || link.kind === 'invitation' && !preview?.accountExists ? 'new-password' : 'current-password'} autoCapitalize="none" autoCorrect={false} editable={!busy} />}
        {(link.kind === 'reset' || link.kind === 'invitation' && !preview?.accountExists) && <PasswordField ref={(value) => { inputs.current.confirm = value; }} error={fieldErrors.confirm} label="Confirme a senha" value={confirm} onChangeText={change('confirm', setConfirm)} autoComplete="new-password" autoCapitalize="none" editable={!busy} />}
        {link.kind === 'verify' && <Txt kind="small" color={colors.muted}>Informe a senha escolhida no cadastro. Se você já tem uma sessão do convite, pode confirmar sem digitá-la.</Txt>}
        {link.kind === 'invitation' && !preview?.accountExists && <><TermsConsent accepted={accepted} onChange={(value) => { setAccepted(value); setFieldErrors((current) => ({ ...current, accepted: undefined })); }} disabled={busy} />{fieldErrors.accepted && <ErrorText text={fieldErrors.accepted} />}</>}
        <Action label={link.kind === 'invitation' ? 'Aceitar convite' : 'Confirmar e continuar'} busy={busy} onPress={() => void submit()} />
      </>}
      {!!error && <ErrorText text={error} />}<Action plain label="Voltar" disabled={busy} onPress={onClose} />
    </>}
  </ScrollView></KeyboardAvoidingView>;
}
