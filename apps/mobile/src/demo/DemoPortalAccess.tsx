import { useEffect, useRef, useState } from 'react';
import type { Context } from '@ageniza/contracts';
import { api } from '../api/runtime';
import { Action, Card, ErrorText, Info, Txt } from '../product/ui';
import { demoAgencyName, demoWorkspaceEnabled } from './config';
import { prepareDemoPortalAccess, type DemoPortal } from './portal-access';

type Props = {
  agency: Extract<Context, { type: 'agency' }>;
  onEnter(context: DemoPortal): void | Promise<void>;
  disabled?: boolean;
};

export function DemoPortalAccess(props: Props) {
  if (!demoWorkspaceEnabled || !props.agency.isOwner || props.agency.agencyName !== demoAgencyName) return null;
  return <PortalAccess key={props.agency.agencyId} {...props} />;
}

function PortalAccess({ agency, onEnter, disabled = false }: Props) {
  const [portal, setPortal] = useState<DemoPortal>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const mounted = useRef(true);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; operation.current?.abort(); }; }, []);

  async function act() {
    if (pending.current || disabled || !mounted.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      if (portal) await onEnter(portal);
      else {
        operation.current = new AbortController();
        const resolved = await prepareDemoPortalAccess(api, agency, operation.current.signal);
        if (mounted.current) setPortal(resolved);
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Não foi possível preparar seu acesso ao portal. Tente novamente.');
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <Card><Txt kind="section">Portal do cliente de exemplo</Txt>
    <Txt>Use sua própria conta para conhecer a aprovação de conteúdos da Clínica Vida · Exemplo.</Txt>
    <Info title={portal ? 'Seu acesso está pronto' : 'Um acesso só para você'} text={portal ? 'O servidor confirmou seu acesso ao portal do cliente de exemplo.' : 'Ao preparar, seu e-mail verificado recebe um acesso real ao cliente da sua agência de demonstração e um e-mail de boas-vindas. Acessos removidos precisam ser reativados em Clientes.'} />
    {!!error && <ErrorText text={error} />}
    <Action soft label={portal ? 'Entrar no portal de exemplo' : 'Preparar meu acesso ao portal de exemplo'} busy={busy} disabled={disabled} onPress={() => void act()} />
  </Card>;
}
