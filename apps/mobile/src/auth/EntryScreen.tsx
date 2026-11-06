import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, ScrollView, Switch, View } from 'react-native';
import { AuthEmailSchema, AuthLoginRequestSchema, AuthSignUpRequestSchema, CreateAgencyRequestSchema } from '@ageniza/contracts';
import type { Context, CreateAgencyResponse } from '@ageniza/contracts';
import { api, browserPreview, webUrl } from '../api/runtime';
import { Action, ErrorText, Field, Header, Heading, Info, Txt, colors, ui } from '../product/ui';
import type { Entry } from './session';
import { DemoWorkspace } from '../demo/DemoWorkspace';
import { demoWorkspaceEnabled } from '../demo/config';
import { TermsConsent } from './AccountAction';
import { parseAccountLink } from './links';
import type { AccountLink } from './links';

type Form = 'login' | 'signup' | 'forgot' | 'resend' | 'link';
const titles: Record<Form, string> = { login: 'Entre no seu fluxo.', signup: 'Organize sua agência.', forgot: 'Recupere seu acesso.', resend: 'Confirme seu e-mail.', link: 'Continue pelo seu link.' };
export function Login({ onLogin, onLink }: { onLogin(): Promise<void>; onLink(link: AccountLink): void }) {
  const [form, setForm] = useState<Form>('login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [linkText, setLinkText] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const changeForm = (next: Form) => { setForm(next); setSent(false); setError(''); setPassword(''); setConfirm(''); setAccepted(false); };
  async function submit() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      if (form === 'link') {
        const link = parseAccountLink(linkText, webUrl);
        if (!link) throw new Error('Cole o link completo enviado pelo Ageniza. Links de outros sites não são aceitos.');
        setLinkText(''); onLink(link); return;
      }
      if (browserPreview) throw new Error('Este endereço web ainda não está autorizado para sessões reais. Use o aplicativo nativo conectado à API.');
      if (form === 'signup') {
        if (password !== confirm) throw new Error('As senhas precisam ser iguais.');
        const parsed = AuthSignUpRequestSchema.safeParse({ name, email, password, acceptTerms: accepted });
        if (!parsed.success) throw new Error('Informe seu nome, um e-mail válido, uma senha de 10 a 128 caracteres e aceite os documentos.');
        await api.request('/auth/sign-up', { method: 'POST', body: parsed.data });
        setPassword(''); setConfirm(''); setSent(true);
      } else if (form === 'forgot' || form === 'resend') {
        const parsed = AuthEmailSchema.safeParse(email);
        if (!parsed.success) throw new Error('Informe um e-mail válido.');
        await api.request(form === 'forgot' ? '/auth/password/forgot' : '/auth/email/verification/resend', { method: 'POST', body: { email: parsed.data } });
        setSent(true);
      } else {
        const parsed = AuthLoginRequestSchema.safeParse({ email, password });
        if (!parsed.success) throw new Error('Informe um e-mail válido e sua senha.');
        await api.request('/auth/login', { method: 'POST', body: parsed.data });
        setPassword(''); await onLogin();
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível concluir. Tente novamente.'); }
    finally { pending.current = false; setBusy(false); }
  }
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}><ScrollView contentContainerStyle={[ui.body, { flexGrow: 1, justifyContent: 'center' }]} keyboardShouldPersistTaps="handled">
    <Header /><Heading title={titles[form]} subtitle={form === 'login' ? 'Conteúdos, clientes e aprovações. Tudo no mesmo lugar.' : undefined} />
    {browserPreview && <Info warning title="Acesso real pelo aplicativo" text="Este endereço web de desenvolvimento ainda não permite login com a API. Use o aplicativo nativo para entrar na sua conta e acessar seus dados." />}
    {sent ? <><Info title="Confira seu e-mail" text={form === 'forgot' ? 'Se houver uma conta com esse endereço, enviaremos um link para redefinir a senha.' : 'Se for necessário confirmar esse endereço, você receberá as instruções. Confira também o spam.'} /><Action soft label="Já tenho o link" onPress={() => changeForm('link')} />{demoWorkspaceEnabled && <Action soft label="Caixa de testes da equipe" onPress={() => void Linking.openURL('https://mail-dev.ageniza.com.br/')} />}</> : <>
      {form === 'link' ? <Field label="Link recebido por e-mail" value={linkText} onChangeText={setLinkText} autoCapitalize="none" autoCorrect={false} editable={!busy} /> : <>
        {form === 'signup' && <Field label="Seu nome" value={name} onChangeText={setName} autoComplete="name" editable={!busy} />}
        <Field label="E-mail" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" editable={!busy} />
        {(form === 'login' || form === 'signup') && <Field label="Senha" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete={form === 'login' ? 'current-password' : 'new-password'} editable={!busy} onSubmitEditing={() => void submit()} />}
        {form === 'signup' && <><Field label="Confirme a senha" value={confirm} onChangeText={setConfirm} secureTextEntry autoComplete="new-password" autoCapitalize="none" editable={!busy} /><TermsConsent accepted={accepted} onChange={setAccepted} disabled={busy} /></>}
      </>}
      <Action label={form === 'login' ? 'Entrar' : form === 'signup' ? 'Criar minha conta' : form === 'link' ? 'Abrir link no app' : 'Enviar e-mail'} busy={busy} onPress={() => void submit()} />
    </>}
    {!!error && <ErrorText text={error} />}
    {form === 'login' ? <><Action plain label="Esqueci minha senha" disabled={busy} onPress={() => changeForm('forgot')} /><Action soft label="Criar conta" disabled={busy} onPress={() => changeForm('signup')} /><Action plain label="Reenviar confirmação do e-mail" disabled={busy} onPress={() => changeForm('resend')} /><Action plain label="Abrir convite ou link recebido" disabled={busy} onPress={() => changeForm('link')} /></> : <Action plain label="Voltar para entrar" disabled={busy} onPress={() => changeForm('login')} />}
    <Txt kind="micro" color={colors.muted} center>Ageniza · sua agência, organizada em fluxo.</Txt>
  </ScrollView></KeyboardAvoidingView>;
}

export function EntryScreen({ entry, onSelect, onContinue, busy, onLink }: { entry: Exclude<Entry, { kind: 'active' }>; onSelect(context: Context): void; onContinue(): Promise<void>; busy: boolean; onLink(link: AccountLink): void }) {
  const [accepted, setAccepted] = useState(false);
  const [agencyName, setAgencyName] = useState('');
  const [creating, setCreating] = useState(false);
  const [linkText, setLinkText] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  async function save(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setSaving(true); setError('');
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível concluir. Tente novamente.'); }
    finally { pending.current = false; setSaving(false); }
  }
  const createAgency = () => void save(async () => {
    const parsed = CreateAgencyRequestSchema.safeParse({ name: agencyName });
    if (!parsed.success) throw new Error('Informe um nome válido para sua agência, com até 256 caracteres.');
    const response = await api.request<CreateAgencyResponse>('/agencies', { method: 'POST', body: parsed.data });
    onSelect(response.context);
  });
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={ui.body}>
    <Heading title={entry.kind === 'unverified' ? 'Confirme seu e-mail' : entry.kind === 'legal' ? 'Antes de continuar' : entry.kind === 'empty' ? 'Bem-vindo ao Ageniza' : 'Onde vamos trabalhar?'} />
    {entry.kind === 'contexts' && <><Txt color={colors.muted}>Escolha uma agência ou o portal de um cliente.</Txt>{entry.contexts.map((context) => <Action key={context.type === 'agency' ? context.agencyId : context.clientId} soft disabled={busy || saving} label={context.type === 'agency' ? `${context.agencyName} · ${context.isOwner ? 'Proprietário' : context.roleName}` : `${context.clientName} · Portal de ${context.agencyName}`} onPress={() => onSelect(context)} />)}</>}
    {(entry.kind === 'empty' || entry.kind === 'contexts' && entry.canCreateAgency) && <><Info title="Seu teste começa com sua agência" text="14 dias para organizar até 3 clientes, com 3 colaboradores e 2 GB de armazenamento." />{creating || entry.kind === 'empty' ? <><Field label="Nome da agência" value={agencyName} onChangeText={setAgencyName} editable={!saving} /><Action label="Criar agência e começar" busy={saving} disabled={busy} onPress={createAgency} /></> : <Action soft label="Criar agência" onPress={() => setCreating(true)} />}</>}
    {(entry.kind === 'empty' || entry.kind === 'contexts' && entry.canCreateAgency) && <DemoWorkspace onEnter={onSelect} />}
    {(entry.kind === 'empty' || entry.kind === 'unverified') && <><Info title={entry.kind === 'unverified' ? 'O e-mail ainda não foi confirmado' : 'Recebeu um convite?'} text="Cole o link completo recebido por e-mail para continuar aqui no aplicativo." /><Field label="Link do e-mail" value={linkText} onChangeText={setLinkText} autoCapitalize="none" autoCorrect={false} /><Action soft label="Abrir link" onPress={() => { const link = parseAccountLink(linkText, webUrl); if (link) { setLinkText(''); onLink(link); } else setError('Cole um link válido do Ageniza.'); }} />{entry.kind === 'unverified' && <Action soft busy={saving} label="Reenviar confirmação" onPress={() => void save(async () => { await api.request('/auth/email/verification/resend', { method: 'POST', body: { email: entry.email } }); setError('Se necessário, um novo e-mail será enviado. Confira sua caixa de entrada.'); })} />}<Action plain label="Atualizar meus acessos" busy={busy} onPress={() => void onContinue()} /></>}
    {entry.kind === 'legal' && <><Txt>Leia os documentos vigentes antes de registrar seu aceite.</Txt><Action soft label="Ler Termos de Uso" onPress={() => void Linking.openURL(`${webUrl}/termos`)} /><Action soft label="Ler Política de Privacidade" onPress={() => void Linking.openURL(`${webUrl}/privacidade`)} /><View style={ui.row}><Switch accessibilityLabel="Li e aceito os documentos pendentes" value={accepted} onValueChange={setAccepted} disabled={saving} /><View style={{ flex: 1 }}><Txt>Li e aceito os documentos pendentes.</Txt></View></View><Action label="Aceitar e continuar" disabled={!accepted || busy} busy={saving} onPress={() => void save(async () => { for (const document of entry.documents.filter((item) => item.pending)) await api.request('/me/legal-acceptances', { method: 'POST', body: { document: document.document } }); await onContinue(); })} /></>}
    {entry.kind === 'unverified' && <><Info title="Confirmação do e-mail" text="Enviamos um link de confirmação para o seu e-mail. Confira também o spam." />{demoWorkspaceEnabled && <Action soft label="Caixa de testes da equipe" onPress={() => void Linking.openURL('https://mail-dev.ageniza.com.br/')} />}</>}
    {!!error && <ErrorText text={error} />}
  </ScrollView>;
}
