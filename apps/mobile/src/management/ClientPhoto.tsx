import { useRef, useState } from 'react';
import { View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { PROFILE_PHOTO_MAX_BYTES, UploadClientPhotoRequestSchema } from '@ageniza/contracts';
import { api } from '../api/runtime';
import { Action, Avatar, ErrorText, Info } from '../product/ui';

export function ClientPhoto({ root, name, photoUrl, editable, onChanged }: { root: string; name: string; photoUrl: string | null; editable: boolean; onChanged(): Promise<void> }) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState(false);
  async function change(remove: boolean) {
    if (pending.current || !editable) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    let saved = false;
    try {
      if (remove) await api.request(`${root}/photo`, { method: 'DELETE' });
      else {
        const selected = await DocumentPicker.getDocumentAsync({ type: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'], copyToCacheDirectory: true });
        if (selected.canceled) return;
        const file = selected.assets[0];
        if ((file.size ?? 0) > PROFILE_PHOTO_MAX_BYTES) throw new Error('Escolha uma imagem de até 10 MB.');
        const blob = file.file ?? await (await fetch(file.uri)).blob();
        if (blob.size > PROFILE_PHOTO_MAX_BYTES) throw new Error('Escolha uma imagem de até 10 MB.');
        const imageBase64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.onerror = () => reject(new Error('Não foi possível ler a imagem.')); reader.readAsDataURL(blob); });
        await api.request(`${root}/photo`, { method: 'PUT', body: UploadClientPhotoRequestSchema.parse({ imageBase64 }) });
      }
      saved = true; setConfirm(false); setNotice(remove ? 'Foto removida.' : 'Foto atualizada.'); await onChanged();
    } catch (cause) { setError(saved ? 'A foto foi atualizada no servidor. Atualize o cadastro para recarregar a imagem.' : cause instanceof Error ? cause.message : 'Não foi possível atualizar a foto.'); }
    finally { pending.current = false; setBusy(false); }
  }
  return <View style={{ gap: 12 }}><Avatar name={name} imageUrl={photoUrl} size={64} />{!!error && <ErrorText text={error} />}{!!notice && <Info title={notice} />}{editable && <><Action soft label="Alterar foto do cliente" busy={busy} onPress={() => void change(false)} />{photoUrl && (confirm ? <><Info warning title="Remover a foto do cliente?" text="O cadastro será identificado pelas iniciais. Você poderá enviar outra imagem depois." /><Action label="Confirmar remoção da foto" busy={busy} onPress={() => void change(true)} /><Action plain label="Manter foto" onPress={() => setConfirm(false)} /></> : <Action plain label="Remover foto do cliente" onPress={() => setConfirm(true)} />)}</>}</View>;
}
