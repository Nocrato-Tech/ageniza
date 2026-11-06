import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Check, Circle } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';

import { ClientListResponseSchema, ContentActivationResponseSchema } from '@ageniza/contracts';
import { ButtonLink } from '@ageniza/ui';

import { useCan, useWriteBlocked } from './agency.js';
import { apiPath } from './api-path.js';
import { useApiClient } from './http.js';
import type { MilestoneFacts } from './milestones.js';

interface Step {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly done: boolean;
  readonly action: { readonly to: string; readonly label: string } | null;
}

/**
 * The facts behind the activation path, read from what already exists (decision 2026-11-06): the roster and three facts about
 * the contents. Nothing is stored; `undefined` until both answers arrive, and also when either fails, so the Início stays as it was.
 */
export function useActivationFacts(agencyId: string, enabled: boolean) {
  const httpClient = useApiClient();
  const clients = useQuery({
    queryKey: ['agency', agencyId, 'activation', 'clients'],
    queryFn: () => httpClient.request({ path: `${apiPath('/agencies/:agencyId/clients', { agencyId })}?page=1&pageSize=1`, response: ClientListResponseSchema }),
    enabled
  });
  const contents = useQuery({
    queryKey: ['agency', agencyId, 'activation', 'contents'],
    queryFn: () => httpClient.request({ path: apiPath('/agencies/:agencyId/contents/activation', { agencyId }), response: ContentActivationResponseSchema }),
    enabled
  });

  const rosterSize = clients.data?.meta.totalItems;
  const firstClientId = clients.data?.data[0]?.id;
  const flags = contents.data?.data;
  const facts = useMemo<MilestoneFacts | undefined>(() => {
    if (rosterSize === undefined || flags === undefined) return undefined;
    return { client: rosterSize > 0 || flags.hasContent, content: flags.hasContent, sent: flags.sentForApproval, approved: flags.approvedByClient, published: flags.published };
  }, [rosterSize, flags]);
  return { facts, firstClientId };
}

/** Four steps from the first client to the first approval; each one leads to the screen that resolves it, when the role can do it. */
export function ActivationPath({ facts, firstClientId }: { facts: MilestoneFacts | undefined; firstClientId: string | undefined }) {
  const canRegister = useCan('cliente.cadastrar');
  const canInvite = useCan('cliente.convidar_usuario');
  const canOperate = useCan('conteudo.operar');
  const blocked = useWriteBlocked() !== undefined;
  if (facts === undefined || facts.approved) return null;

  const calendar = firstClientId === undefined ? 'conteudos' : `conteudos/${firstClientId}`;
  const steps: Step[] = [
    {
      key: 'client', title: 'Cadastre o primeiro cliente', description: 'Só o nome é obrigatório. O resto você completa depois.',
      done: facts.client, action: canRegister && !blocked ? { to: 'clientes', label: 'Cadastrar cliente' } : null
    },
    {
      key: 'content', title: 'Crie o primeiro conteúdo no calendário', description: 'Escolha o dia e o formato do post.',
      done: facts.content, action: canOperate && !blocked && firstClientId !== undefined ? { to: calendar, label: 'Criar conteúdo' } : null
    },
    {
      key: 'sent', title: 'Envie o conteúdo para aprovação', description: 'O cliente vê o post no portal e aprova ou pede ajuste.',
      done: facts.sent, action: canOperate && !blocked && firstClientId !== undefined ? { to: calendar, label: 'Enviar para aprovação' } : null
    },
    {
      key: 'approved', title: 'Receba a primeira aprovação do cliente', description: 'Convide quem aprova os posts para o portal e acompanhe a resposta.',
      done: facts.approved, action: canInvite && !blocked && firstClientId !== undefined ? { to: `clientes/${firstClientId}/acessos`, label: 'Convidar o cliente' } : null
    }
  ];
  const doneCount = steps.filter((step) => step.done).length;

  return <section aria-labelledby="activation-title" className="activation">
    <header className="activation__header">
      <h2 id="activation-title">Primeiros passos</h2>
      <p>{doneCount} de {steps.length} concluídos</p>
    </header>
    <ol className="activation__steps">
      {steps.map((step) => <li key={step.key} className="activation__step" data-done={step.done}>
        {step.done ? <Check className="activation__mark" aria-hidden="true" /> : <Circle className="activation__mark" aria-hidden="true" />}
        <span className="activation__text">
          <span className="activation__title">{step.title}<span className="activation__state"> — {step.done ? 'feito' : 'pendente'}</span></span>
          <span className="activation__description">{step.description}</span>
        </span>
        {!step.done && step.action !== null && <ButtonLink as={Link} to={step.action.to} variant="secondary">{step.action.label}</ButtonLink>}
      </li>)}
    </ol>
  </section>;
}
