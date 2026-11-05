import { useRef, useState } from 'react';
import { Action, Card, ErrorText, Info, Txt } from '../product/ui';
import type { Activity } from '../product/types';
import { sendContentNotification } from './notifications';

export function WebNotifications({ activities }: { activities: Activity[] }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const pending = useRef(false);
  async function send() {
    if (pending.current || !activities.length) return;
    pending.current = true; setBusy(true); setNotice(''); setError('');
    try {
      const result = await sendContentNotification(activities.length);
      setNotice(result === 'sent' ? 'Aviso enviado ao navegador.' : result === 'denied' ? 'Permissão não concedida. Confira as permissões deste site.' : 'Este navegador não oferece notificações compatíveis. Experimente Chrome ou Edge no computador.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível enviar o aviso.'); }
    finally { pending.current = false; setBusy(false); }
  }
  return <Card><Txt kind="section">Avisos no navegador</Txt><Txt>Envie um aviso sobre as atividades carregadas, sem expor nome de cliente ou conteúdo na tela bloqueada.</Txt><Action label="Enviar aviso das atividades" disabled={!activities.length} busy={busy} onPress={() => void send()} />{!activities.length && <Txt>Nenhuma atividade no período para notificar.</Txt>}{busy && <Info title="Confira a permissão do navegador" />}{!!notice && <Info title={notice} />}{!!error && <ErrorText text={error} />}<Txt kind="small">Envio local por este botão. Não é push remoto com o app fechado.</Txt></Card>;
}
