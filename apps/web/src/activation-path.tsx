import { useMemo, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Send, UserPlus } from 'lucide-react';

import { ClientListResponseSchema, ContentActivationResponseSchema, type ContentActivationResponse } from '@ageniza/contracts';
import { ButtonLink, MilestoneTrail, Stage3D, StatusTag, type MilestoneStep } from '@ageniza/ui';

import { useAgencyContext, useCan, useWriteBlocked } from './agency.js';
import { apiPath } from './api-path.js';
import { CopyPortalAccessButton } from './copy-invitation-link.js';
import { instantLabel } from './home-dates.js';
import { useApiClient } from './http.js';
import { milestoneSeen, type MilestoneFacts, type MilestoneKey } from './milestones.js';
import { portalEntryAddress, portalShareMessage, whatsappShareUrl } from './portal-access-share.js';

export type ActivationSteps = ContentActivationResponse['data']['steps'];

type StepKey = 'client' | 'content' | 'sent' | 'approved';

interface Step {
  readonly key: StepKey;
  readonly title: string;
  readonly description: string;
  /** What the journey says under the count while this step is the one to take. */
  readonly lead: string;
  readonly done: boolean;
  readonly action: ReactNode;
}

/**
 * The facts behind the activation path, read from what already exists (decision 2026-11-06): the roster and what the contents say
 * of each step. Nothing is stored; `undefined` until both answers arrive, and also when either fails, so the Início stays as it was.
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
  const firstClientName = clients.data?.data[0]?.name;
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
  return { facts, pathFacts, firstClientId, firstClientName, rosterSize, steps: flags?.steps };
}

/** "Rosana Teixeira e mais 2": the person of the send and the others who got the access. */
const sentTo = (step: NonNullable<ActivationSteps['firstSent']>): string => `${step.name}${step.others > 0 ? ` e mais ${step.others}` : ''}`;

/** What a done step says: the name that goes with it and the day, in the words of the board ("Padaria Central · 3 de novembro"). */
const whenOf = (key: StepKey, steps: ActivationSteps | undefined): string | undefined => {
  if (steps === undefined) return undefined;
  const day = (at: string): string => instantLabel(at);
  switch (key) {
    case 'client': return steps.firstClient === null ? undefined : `${steps.firstClient.name} · ${day(steps.firstClient.at)}`;
    case 'content': return steps.firstContent === null ? undefined : `${steps.firstContent.name} · ${day(steps.firstContent.at)}`;
    case 'sent': return steps.firstSent === null ? undefined : `Enviado a ${sentTo(steps.firstSent)} · ${day(steps.firstSent.at)}`;
    case 'approved': return steps.firstApproved === null ? undefined : `Aprovado por ${steps.firstApproved.name} · ${day(steps.firstApproved.at)}`;
  }
};

/**
 * The journey "Até a primeira aprovação": four steps from the first client to the client's approval, on the milestone trail.
 * The first pending step is the current one and carries the way forward to the screen that resolves it, when the role can do it.
 */
export function ActivationPath({ facts, firstClientId, firstClientName, steps: stepFacts }: {
  facts: MilestoneFacts | undefined;
  firstClientId: string | undefined;
  firstClientName: string | undefined;
  steps: ActivationSteps | undefined;
}) {
  const location = useLocation();
  const agency = useAgencyContext();
  const canRegister = useCan('cliente.cadastrar');
  const canInvite = useCan('cliente.convidar_usuario');
  const canOperate = useCan('conteudo.operar');
  const blocked = useWriteBlocked() !== undefined;
  if (facts === undefined || facts.approved) return null;

  const calendar = firstClientId === undefined ? 'conteudos' : `conteudos/${firstClientId}`;
  const goTo = (to: string, label: string, icon: ReactNode): ReactNode => <ButtonLink as={Link} to={to} state={location.state} leadingIcon={icon}>{label}</ButtonLink>;
  const shareMessage = portalShareMessage({ agencyName: agency.agencyName, clientName: firstClientName ?? '', personName: null, address: portalEntryAddress() });
  const steps: Step[] = [
    {
      key: 'client', title: 'Cadastre o primeiro cliente', description: 'Cadastre a primeira pessoa que vai aprovar os posts.',
      lead: 'Cadastre o primeiro cliente para começar.', done: facts.client,
      action: canRegister && !blocked ? goTo('clientes', 'Cadastrar cliente', <UserPlus />) : undefined
    },
    {
      key: 'content', title: 'Crie o primeiro conteúdo no calendário', description: 'Planeje um post para o cliente ver.',
      lead: 'Falta criar o primeiro conteúdo no calendário.', done: facts.content,
      action: canOperate && !blocked && firstClientId !== undefined ? goTo(calendar, 'Criar conteúdo', <Plus />) : undefined
    },
    {
      key: 'sent', title: 'Envie o conteúdo para aprovação', description: 'Mande o post para o cliente aprovar.',
      lead: 'Falta enviar o conteúdo para aprovação.', done: facts.sent,
      action: canOperate && !blocked && firstClientId !== undefined ? goTo(calendar, 'Enviar para aprovação', <Send />) : undefined
    },
    {
      key: 'approved', title: 'Seu cliente aprova pelo link, sem criar conta',
      description: 'Mande o link pelo WhatsApp. O cliente vê o post no celular e aprova em menos de um minuto.',
      lead: 'O último passo é do seu cliente. Mande o link e acompanhe daqui.', done: facts.approved,
      action: canInvite && firstClientId !== undefined
        ? <>
          <ButtonLink href={whatsappShareUrl(shareMessage)} target="_blank" rel="noopener noreferrer" leadingIcon={<Send />} aria-label="Enviar link de aprovação (abre em nova aba)">Enviar link de aprovação</ButtonLink>
          <CopyPortalAccessButton message={shareMessage} address={portalEntryAddress()} subject={firstClientName ?? 'o cliente'} />
        </>
        : undefined
    }
  ];
  const doneCount = steps.filter((step) => step.done).length;
  const current = steps.find((step) => !step.done);

  const trail: MilestoneStep[] = steps.map((step) => {
    const when = whenOf(step.key, stepFacts);
    return {
      id: step.key,
      status: step.done ? 'done' : step.key === current?.key ? 'current' : 'upcoming',
      title: step.title,
      when: <span className="activation__when"><StatusTag status="ready">Feito</StatusTag>{when !== undefined && <span>{when}</span>}</span>,
      description: step.description,
      action: step.action
    };
  });

  return <section aria-labelledby="activation-title" className="activation" data-stage-host>
    <div className="activation__intro">
      <Stage3D src="/3d/rocket.png" tone="indigo" size="xl" />
      <h2 id="activation-title" className="activation__eyebrow">Até a primeira aprovação</h2>
      <p className="activation__count"><strong>{doneCount}</strong> de {steps.length} passos</p>
      <progress className="activation__progress" max={steps.length} value={doneCount} aria-label="Passos concluídos até a primeira aprovação" />
      {current !== undefined && <p className="activation__lead">{current.lead}</p>}
    </div>
    <div className="activation__steps">
      <MilestoneTrail steps={trail} aria-label="Passos até a primeira aprovação" />
    </div>
  </section>;
}
