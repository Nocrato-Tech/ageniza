import { useCallback, useState } from 'react';
import { View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { EmailChangeRequestSchema, PROFILE_PHOTO_MAX_BYTES, UpdateMyProfileRequestSchema } from '@ageniza/contracts';
import type { AuthSessionResponse } from '@ageniza/contracts';
import { api } from '../api/runtime';
import { Action, Avatar, Card, ErrorText, Field, Heading, Info, Txt, ui } from '../product/ui';
import { useRemoteResource } from './useRemoteResource';

export function ProfileScreen({ onChanged, onExit, onContext }: { onChanged(): Promise<void>; onExit(): Promise<void> | void; onContext?(): Promise<void> | void }) {
  const load = useCallback((signal: AbortSignal) => api.request<AuthSessionResponse>('/auth/session', { signal }), []);
  const { data, busy, error, notice, run } = useRemoteResource(load);
  const [name, setName] = useState<string>();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmAll, setConfirmAll] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  async function uploadPhoto() {
    const picked = await DocumentPicker.getDocumentAsync({ type: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'], copyToCacheDirectory: true });
    if (picked.canceled) return;
    const file = picked.assets[0];
    if ((file.size ?? 0) > PROFILE_PHOTO_MAX_BYTES) throw new Error('Escolha uma imagem de até 10 MB.');
    const blob = file.file ?? await (await fetch(file.uri)).blob();
    if (blob.size > PROFILE_PHOTO_MAX_BYTES) throw new Error('Escolha uma imagem de até 10 MB.');
    const imageBase64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.onerror = () => reject(new Error('Não foi possível ler a imagem.')); reader.readAsDataURL(blob); });
    await api.request('/me/photo', { method: 'POST', body: { imageBase64 } });
    await onChanged();
  }
  return <View style={{ gap: 16 }}><Heading title="Sua conta" subtitle="Seu perfil é o mesmo em todas as agências e portais." />{!!error && <ErrorText text={error} />}{!!notice && <Info title={notice} />}
    {data && <><Card><View style={ui.row}><Avatar name={data.user.name} accent /><View style={{ flex: 1 }}><Txt kind="strong">{data.user.name}</Txt><Txt>{data.user.email}</Txt></View></View><Action soft label="Alterar foto do perfil" busy={busy} onPress={() => void run(uploadPhoto, 'Foto do perfil atualizada.')} /></Card>
      <Field label="Seu nome" value={name ?? data.user.name} onChangeText={setName} /><Action label="Salvar nome" busy={busy} onPress={() => void run(async () => { const parsed = UpdateMyProfileRequestSchema.safeParse({ name: name ?? data.user.name }); if (!parsed.success) throw new Error('Informe um nome válido.'); await api.request('/me/profile', { method: 'PATCH', body: parsed.data }); await onChanged(); }, 'Nome atualizado.')} />
      <Card><Txt kind="section">E-mail da conta</Txt><Info title="Troca acompanhada pela operação" text="Após a aprovação, você receberá um link no novo endereço. O e-mail atual só muda quando esse link for confirmado." /><Field label="Novo e-mail" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" /><Field label="Senha atual" value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" autoCapitalize="none" /><Action soft label="Solicitar troca de e-mail" busy={busy} onPress={() => void run(async () => { const parsed = EmailChangeRequestSchema.safeParse({ newEmail: email, ...(password ? { currentPassword: password } : {}) }); if (!parsed.success) throw new Error('Confira o novo e-mail e sua senha atual.'); await api.request('/me/email-change', { method: 'POST', body: parsed.data }); setPassword(''); setEmail(''); }, 'Se a solicitação puder continuar, a operação acompanhará a troca.')} /></Card>
      <Card><Txt kind="section">Segurança</Txt><Txt>Para alterar a senha, enviamos um link ao e-mail da sua conta. A redefinição encerra todas as sessões.</Txt><Action soft label="Enviar link para alterar senha" disabled={resetSent} busy={busy} onPress={() => void run(async () => { await api.request('/auth/password/forgot', { method: 'POST', body: { email: data.user.email } }); setResetSent(true); }, 'Confira seu e-mail para redefinir a senha.')} />{confirmAll ? <><Info warning title="Sair de todos os aparelhos?" text="Todas as suas sessões serão encerradas, inclusive a deste aplicativo." /><Action label="Confirmar saída de todos os aparelhos" busy={busy} onPress={() => void run(async () => { await api.request('/auth/logout-all', { method: 'POST' }); await onExit(); }, 'Sessões encerradas.')} /><Action plain label="Manter minhas sessões" onPress={() => setConfirmAll(false)} /></> : <Action plain label="Sair de todos os aparelhos" onPress={() => setConfirmAll(true)} />}</Card>
    </>}
    {onContext && <Action soft label="Trocar agência ou portal" onPress={() => void onContext()} />}<Action plain label="Sair desta conta" busy={busy} onPress={() => void onExit()} />
  </View>;
}
