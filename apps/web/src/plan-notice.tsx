import { Link } from 'react-router-dom';
import { CircleAlert, Info } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';

import type { AgencyPlan } from '@ageniza/contracts';
import { ButtonLink } from '@ageniza/ui';

import { useApiClient } from './http.js';
import { subscriptionOverviewQuery } from './subscription-queries.js';

const DAY_MS = 86_400_000;

/** From this many days before the end of the trial or of a canceled period, the Owner gets the highlighted warning. */
export const PRE_NOTICE_DAYS = 3;

/** Whole days left, counting a started day as one: the trial that ends this afternoon still has 1 day. */
export const trialDaysLeft = (trialEndsAt: string, now: Date = new Date()): number =>
  Math.max(0, Math.ceil((Date.parse(trialEndsAt) - now.getTime()) / DAY_MS));

const formatDate = (iso: string): string =>
  new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', timeZone: 'America/Sao_Paulo' }).format(new Date(iso));

const daysText = (days: number): string => (days === 1 ? 'falta 1 dia' : `faltam ${days} dias`);

/** The reason a blocked action shows on hover and focus (decision 2026-10-27, the owner's choice). */
export const PLAN_RENEWAL_REASON = 'O plano precisa ser renovado para usar esta opção.';

export const AGENCY_READ_ONLY_TEXT = 'O seu plano precisa ser renovado para usar as opções bloqueadas. Os seus dados estão guardados.';

/** What the client of the agency is told wherever the portal blocks a decision: nothing about the agency's plan (decision 2026-11-06). */
export const PORTAL_PAUSED_REASON = 'A aprovação está pausada no momento. A agência já foi avisada.';

const READ_ONLY_CONSEQUENCE = 'a agência fica somente leitura: tudo continua visível, mas ninguém cria nem edita.';

function SubscribeLink({ agencyId, children }: { agencyId: string; children: string }) {
  return <ButtonLink as={Link} to={`/agencia/${agencyId}/assinatura`} size="sm">{children}</ButtonLink>;
}

/**
 * A canceled subscription that is about to end (issue #773): only the Owner can keep it, so only the Owner is warned, in the
 * last days. The end of the period is not in the agency's context, so it is read from the subscription, which only the Owner may.
 */
function CanceledPeriodNotice({ agencyId, now }: { agencyId: string; now?: Date | undefined }) {
  const httpClient = useApiClient();
  const { data } = useQuery(subscriptionOverviewQuery(httpClient, agencyId));
  const end = data?.subscription?.currentPeriodEnd ?? null;
  if (end === null) return null;
  const days = trialDaysLeft(end, now);
  if (days > PRE_NOTICE_DAYS) return null;
  return <section className="shell-notice trial-notice trial-notice--urgent" aria-label="Fim da assinatura">
    <CircleAlert className="shell-notice__icon" aria-hidden="true" />
    <p className="shell-notice__text" role="status">
      <strong>A assinatura foi cancelada: {daysText(days)}</strong> (até {formatDate(end)}).
      {' '}Depois disso, {READ_ONLY_CONSEQUENCE} Para continuar, mantenha a assinatura.
    </p>
    <SubscribeLink agencyId={agencyId}>Manter a assinatura</SubscribeLink>
  </section>;
}

/**
 * The top of the agency during and after the trial (issue #714), and the way to subscribe for the Owner (issue #773). After
 * the trial, a banner that stays: the blocked actions remain on screen, disabled, and this says why; the contact appears only
 * when the operation configured one and the person cannot subscribe. In the last days of the trial, and of a canceled period,
 * the Owner gets a highlighted warning with what happens and the way to subscribe. Nothing is shown for an agency out of trial.
 */
export function TrialNotice({ plan, now, agencyId, canSubscribe = false }: { plan: AgencyPlan; now?: Date; agencyId: string; canSubscribe?: boolean }) {
  if (plan.kind === 'ativo' && plan.readOnly) {
    return <section className="shell-notice trial-notice" aria-label="Plano">
      <CircleAlert className="shell-notice__icon" aria-hidden="true" />
      <p className="shell-notice__text" role="status">{AGENCY_READ_ONLY_TEXT}</p>
      {canSubscribe && <SubscribeLink agencyId={agencyId}>Assinar</SubscribeLink>}
    </section>;
  }
  if (plan.kind === 'ativo' && plan.canceled === true && canSubscribe) return <CanceledPeriodNotice agencyId={agencyId} now={now} />;
  if (plan.kind !== 'trial' || plan.trialEndsAt === null) return null;
  if (plan.readOnly) {
    const contact = plan.supportContactEmail ?? null;
    return <section className="shell-notice trial-notice" aria-label="Plano">
      <CircleAlert className="shell-notice__icon" aria-hidden="true" />
      <p className="shell-notice__text" role="status">
        {AGENCY_READ_ONLY_TEXT}
        {!canSubscribe && contact !== null && <>{' '}Para renovar, escreva para <a href={`mailto:${contact}`}>{contact}</a>.</>}
      </p>
      {canSubscribe && <SubscribeLink agencyId={agencyId}>Assinar</SubscribeLink>}
    </section>;
  }
  const days = trialDaysLeft(plan.trialEndsAt, now);
  if (canSubscribe && days <= PRE_NOTICE_DAYS) {
    return <section className="shell-notice trial-notice trial-notice--urgent" aria-label="Período de teste">
      <CircleAlert className="shell-notice__icon" aria-hidden="true" />
      <p className="shell-notice__text" role="status">
        <strong>Período de teste: {daysText(days)}</strong> (até {formatDate(plan.trialEndsAt)}).
        {' '}Quando acabar, {READ_ONLY_CONSEQUENCE} Assine para continuar.
      </p>
      <SubscribeLink agencyId={agencyId}>Assinar</SubscribeLink>
    </section>;
  }
  return <section className="shell-notice trial-notice" aria-label="Período de teste">
    <Info className="shell-notice__icon" aria-hidden="true" />
    <p className="shell-notice__text" role="status">
      <strong>Período de teste: {daysText(days)}</strong> (até {formatDate(plan.trialEndsAt)}).
      {' '}Até lá, a agência tem até 3 clientes ativos, 3 colaboradores e 2 GB de mídia.
    </p>
    {canSubscribe && <SubscribeLink agencyId={agencyId}>Assinar</SubscribeLink>}
  </section>;
}

/**
 * The portal of an agency whose plan ended: the person reads everything and decides nothing. The text is neutral on purpose
 * (decision 2026-11-06): the client of the agency is never told about the agency's billing.
 */
export function PortalReadOnlyNotice({ agencyName }: { agencyName: string }) {
  return <section className="shell-notice trial-notice" aria-label="Portal somente leitura">
    <CircleAlert className="shell-notice__icon" aria-hidden="true" />
    <p className="shell-notice__text" role="status">
      A aprovação está pausada no momento. A equipe de {agencyName} já foi avisada. Tudo continua visível.
    </p>
  </section>;
}
