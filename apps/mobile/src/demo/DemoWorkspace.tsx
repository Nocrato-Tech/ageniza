import { useRef, useState } from 'react';
import { View } from 'react-native';
import type { Context } from '@ageniza/contracts';
import { api } from '../api/runtime';
import { Action, Card, ErrorText, Info, Txt } from '../product/ui';
import { demoWorkspaceEnabled } from './config';
import { DemoPortalAccess } from './DemoPortalAccess';
import type { DemoPortal } from './portal-access';
import { createDemoWorkspace, populateDemoWorkspace } from './workspace';

type Agency = Extract<Context, { type: 'agency' }>;
export function DemoWorkspace({ existing, onEnter, onEnterPortal }: { existing?: Agency; onEnter(context: Agency): void | Promise<void>; onEnterPortal?(context: DemoPortal): void | Promise<void> }) {
  const [context, setContext] = useState(existing);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const pending = useRef(false);
  if (!demoWorkspaceEnabled) return null;
  async function prepare() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      let target = context;
      if (!target) { setProgress('Criando sua agência de demonstração…'); target = await createDemoWorkspace(api); setContext(target); }
      const response = await fetch('/app-mobile/demo/saude-demonstracao.png');
      if (!response.ok) throw new Error('Não foi possível carregar a imagem de exemplo.');
      await populateDemoWorkspace(api, target, await response.blob(), setProgress);
      await onEnter(target);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'A preparação não terminou. Você pode retomar sem recriar a agência.'); }
    finally { pending.current = false; setBusy(false); }
  }
  return <><Card><Txt kind="section">Experimente com dados de exemplo</Txt><Txt>O mesmo app, com login e dados salvos no servidor. Dois clientes fictícios, conteúdos, tarefas e capas para explorar.</Txt>
    <Info title={context ? 'Sua agência de demonstração' : 'Um espaço separado para testar'} text={context ? 'Os exemplos já existentes serão reaproveitados. Seus conteúdos não serão substituídos.' : 'Será criada uma agência própria em teste grátis. Nenhuma agência existente será alterada. E-mails, acessos e pagamentos não são criados automaticamente.'} />
    {!!progress && <View accessibilityLiveRegion="polite"><Txt>{progress}</Txt></View>}{!!error && <ErrorText text={error} />}
    {confirm || context ? <><Action label={context ? 'Continuar preparação dos exemplos' : 'Confirmar e preparar exemplos'} busy={busy} onPress={() => void prepare()} />{context && <Action plain disabled={busy} label="Entrar na agência sem preparar mais dados" onPress={() => void onEnter(context)} />}{!context && <Action plain disabled={busy} label="Agora não" onPress={() => setConfirm(false)} />}</> : <Action soft label="Criar agência de demonstração" onPress={() => setConfirm(true)} />}
  </Card>{context && onEnterPortal && <DemoPortalAccess agency={context} onEnter={onEnterPortal} disabled={busy} />}</>;
}
