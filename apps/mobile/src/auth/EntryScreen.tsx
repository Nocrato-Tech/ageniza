import { useRef, useState } from 'react';
import { Image, KeyboardAvoidingView, Linking, Platform, ScrollView, Switch, View } from 'react-native';
import { AuthLoginRequestSchema } from '@ageniza/contracts';
import type { Context } from '@ageniza/contracts';
import { api, browserPreview, webUrl } from '../api/runtime';
import { Button, Copy, Field, Notice, styles } from '../ui/components';
import { space } from '../ui/theme';
import type { Entry } from './session';
import icon from '../../assets/icon.png';

export function Login({ onLogin }: { onLogin(): Promise<void> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [forgot, setForgot] = useState(false);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  async function submit() {
    if (pending.current) return;
    setError('');
    const parsed = AuthLoginRequestSchema.safeParse({ email, password: forgot ? 'unused' : password });
    if (!parsed.success) { setError('Informe um e-mail válido e sua senha.'); return; }
    pending.current = true; setBusy(true);
    try {
      if (forgot) {
        await api.request('/auth/password/forgot', { method: 'POST', body: { email: parsed.data.email } });
        setSent(true);
      } else {
        await api.request('/auth/login', { method: 'POST', body: parsed.data });
        setPassword('');
        await onLogin();
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível entrar. Tente de novo.'); }
    finally { pending.current = false; setBusy(false); }
  }
  return <KeyboardAvoidingView style={styles.page} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView contentContainerStyle={[styles.body, { justifyContent: 'center' }]} keyboardShouldPersistTaps="handled">
      <View style={styles.row}><Image source={icon} style={{ width: 48, height: 48 }} /><Copy title>Ageniza</Copy></View>
      <View style={{ gap: space.sm }}><Copy title>{forgot ? 'Recuperar sua senha' : 'Entre no seu fluxo.'}</Copy><Copy muted>{forgot ? 'Enviaremos um link para você criar uma nova senha.' : 'Conteúdos, clientes e aprovações. Tudo no mesmo lugar.'}</Copy></View>
      {browserPreview && <Copy muted>Prévia da interface. Para acessar sua conta e seus conteúdos, abra o aplicativo no Expo Go.</Copy>}
      {sent ? <Copy>Se houver uma conta com esse e-mail, o link de recuperação será enviado. No ambiente de teste, consulte a caixa de e-mails do dev.</Copy> : <>
        <Field label="E-mail" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" textContentType="emailAddress" editable={!busy} />
        {!forgot && <Field label="Senha" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="current-password" textContentType="password" onSubmitEditing={() => void submit()} editable={!busy} />}
        {error ? <Notice message={error} /> : null}
        <Button label={forgot ? 'Enviar link de recuperação' : 'Entrar'} disabled={browserPreview} busy={busy} onPress={() => void submit()} />
      </>}
      <Button secondary disabled={busy} label={forgot ? 'Voltar para entrar' : 'Esqueci minha senha'} onPress={() => { setForgot(!forgot); setSent(false); setError(''); setPassword(''); }} />
      {!forgot && <Button secondary label="Criar conta" onPress={() => void Linking.openURL(`${webUrl}/criar-conta`)} />}
      <Copy muted>Ambiente de desenvolvimento · dados reais de teste</Copy>
    </ScrollView>
  </KeyboardAvoidingView>;
}

export function EntryScreen({ entry, onSelect, onContinue, busy }: { entry: Exclude<Entry, { kind: 'active' }>; onSelect(context: Context): void; onContinue(): Promise<void>; busy: boolean }) {
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  async function accept() {
    if (entry.kind !== 'legal' || !accepted || pending.current) return;
    pending.current = true; setSaving(true); setError('');
    try {
      for (const document of entry.documents.filter((item) => item.pending)) {
        await api.request('/me/legal-acceptances', { method: 'POST', body: { document: document.document } });
      }
      await onContinue();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível salvar. Tente de novo.'); }
    finally { pending.current = false; setSaving(false); }
  }
  return <ScrollView contentContainerStyle={styles.body}>
    <Copy title>{entry.kind === 'legal' ? 'Antes de continuar' : entry.kind === 'empty' ? 'Comece pela sua agência' : 'Onde vamos trabalhar?'}</Copy>
    {entry.kind === 'contexts' && <><Copy muted>Escolha uma agência ou o portal de um cliente.</Copy>{entry.contexts.map((context) => <Button key={context.type === 'agency' ? context.agencyId : context.clientId}
      secondary disabled={busy} label={context.type === 'agency' ? `${context.agencyName} · ${context.isOwner ? 'Proprietário' : context.roleName}` : `${context.clientName} · Portal de ${context.agencyName}`} onPress={() => onSelect(context)} />)}</>}
    {entry.kind === 'empty' && <><Copy>Crie uma agência pelo site para iniciar seu teste grátis, ou aceite um convite recebido por e-mail. Depois, atualize seus acessos aqui.</Copy><Button label="Criar agência no site" onPress={() => void Linking.openURL(`${webUrl}/comecar`)} /><Button secondary label="Atualizar meus acessos" busy={busy} onPress={() => void onContinue()} /></>}
    {entry.kind === 'legal' && <><Copy>Leia os documentos vigentes antes de registrar seu aceite.</Copy>
      <Button secondary label="Ler Termos de Uso" onPress={() => void Linking.openURL(`${webUrl}/termos`)} />
      <Button secondary label="Ler Política de Privacidade" onPress={() => void Linking.openURL(`${webUrl}/privacidade`)} />
      <View style={styles.row}><Switch accessibilityLabel="Li e aceito os documentos pendentes" value={accepted} onValueChange={setAccepted} disabled={saving} /><View style={{ flex: 1 }}><Copy>Li e aceito os documentos pendentes.</Copy></View></View>
      {error ? <Notice message={error} /> : null}<Button label="Aceitar e continuar" disabled={!accepted} busy={saving} onPress={() => void accept()} />
    </>}
  </ScrollView>;
}
