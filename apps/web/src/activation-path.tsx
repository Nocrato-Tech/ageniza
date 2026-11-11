import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { ClientListResponseSchema, ContentActivationResponseSchema } from '@ageniza/contracts';
import { ButtonLink, MilestoneTrail, Stage3D, type MilestoneStep } from '@ageniza/ui';

import { useCan, useWriteBlocked } from './agency.js';
import { apiPath } from './api-path.js';
import { useApiClient } from './http.js';
import { milestoneSeen, type MilestoneFacts, type MilestoneKey } from './milestones.js';

interface Step {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly done: boolean;
  /** Who does the step: the last one is the client's, not the agency's (decision 2026-11-10). */
  readonly owner: 'agency' | 'client';
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
    enabled,
    // A step done elsewhere must show the moment the person comes back; the default 30 s would keep the old answer.
    refetchOnMount: 'always'
  });
  const contents = useQuery({
    queryKey: ['agency', agencyId, 'activation', 'contents'],
    queryFn: () => httpClient.request({ path: apiPath('/agencies/:agencyId/contents/activation', { agencyId }), response: ContentActivationResponseSchema }),
    enabled,
    refetchOnMount: 'always'
  });

  const rosterSize = clients.data?.meta.totalItems;
  const firstClientId = clients.data?.data[0]?.id;
  const flags = contents.data?.data;
  const facts = useMemo<MilestoneFacts | undefined>(() => {
    if (rosterSize === undefined || flags === undefined) return undefined;
    return { client: rosterSize > 0 || flags.hasContent, content: flags.hasContent, sent: flags.sentForApproval, approved: flags.approvedByClient, published: flags.published };
  }, [rosterSize, flags]);
  // The path is history: what this browser already recorded stays done, even when the data steps back (an edit clears the approval).
  const pathFacts = useMemo<MilestoneFacts | undefined>(() => {
    if (facts === undefined) return undefined;
    const kept = (key: MilestoneKey): boolean => facts[key] || milestoneSeen(agencyId, key);
    return { client: kept('client'), content: kept('content'), sent: kept('sent'), approved: kept('approved'), published: kept('published') };
  }, [agencyId, facts]);
  return { facts, pathFacts, firstClientId };
}

/**
 * The journey "Até a primeira aprovação": four steps from the first client to the client's approval, on the milestone trail.
 * The first pending step is the current one and carries the way forward to the screen that resolves it, when the role can do it.
 */
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
      done: facts.client, owner: 'agency', action: canRegister && !blocked ? { to: 'clientes', label: 'Cadastrar cliente' } : null
    },
    {
      key: 'content', title: 'Crie o primeiro conteúdo no calendário', description: 'Escolha o dia e o formato do post.',
      done: facts.content, owner: 'agency', action: canOperate && !blocked && firstClientId !== undefined ? { to: calendar, label: 'Criar conteúdo' } : null
    },
    {
      key: 'sent', title: 'Envie o conteúdo para aprovação', description: 'O cliente vê o post no portal e aprova ou pede ajuste.',
      done: facts.sent, owner: 'agency', action: canOperate && !blocked && firstClientId !== undefined ? { to: calendar, label: 'Enviar para aprovação' } : null
    },
    {
      key: 'approved', title: 'Seu cliente aprova pelo link, sem criar conta', description: 'Convide quem aprova os posts para o portal e acompanhe a resposta.',
      done: facts.approved, owner: 'client', action: canInvite && !blocked && firstClientId !== undefined ? { to: `clientes/${firstClientId}/acessos`, label: 'Convidar o cliente' } : null
    }
  ];
  const doneCount = steps.filter((step) => step.done).length;
  const current = steps.find((step) => !step.done)?.key;

  const trail: MilestoneStep[] = steps.map((step) => ({
    id: step.key,
    status: step.done ? 'done' : step.key === current ? 'current' : 'upcoming',
    title: <>{step.title}<span className="activation__who">{step.owner === 'client' ? 'Seu cliente' : 'Você'}</span></>,
    description: step.description,
    action: step.action === null ? undefined : <ButtonLink as={Link} to={step.action.to}>{step.action.label}</ButtonLink>
  }));

  return <section aria-labelledby="activation-title" className="activation" data-stage-host>
    <div className="activation__intro">
      <Stage3D src="/3d/rocket.png" tone="indigo" size="xl" />
      <h2 id="activation-title" className="activation__eyebrow">Até a primeira aprovação</h2>
      <p className="activation__count"><strong>{doneCount}</strong> de {steps.length} passos</p>
      <progress className="activation__progress" max={steps.length} value={doneCount} aria-label="Passos concluídos até a primeira aprovação" />
    </div>
    <div className="activation__steps">
      <MilestoneTrail steps={trail} aria-label="Passos até a primeira aprovação" />
    </div>
  </section>;
}
