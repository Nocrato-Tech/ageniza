import { CircleAlert, Info } from 'lucide-react';

import type { AgencyPlan } from '@ageniza/contracts';

const DAY_MS = 86_400_000;

/** Whole days left, counting a started day as one: the trial that ends this afternoon still has 1 day. */
export const trialDaysLeft = (trialEndsAt: string, now: Date = new Date()): number =>
  Math.max(0, Math.ceil((Date.parse(trialEndsAt) - now.getTime()) / DAY_MS));

const endDate = (trialEndsAt: string): string =>
  new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', timeZone: 'America/Sao_Paulo' }).format(new Date(trialEndsAt));

/** The reason a blocked action shows on hover and focus (decision 2026-10-27, the owner's choice). */
export const PLAN_RENEWAL_REASON = 'O plano precisa ser renovado para usar esta opção.';

export const AGENCY_READ_ONLY_TEXT = 'O seu plano precisa ser renovado para usar as opções bloqueadas. Os seus dados estão guardados.';

/**
 * The top of the agency during and after the trial (issue #714). After it, a banner that stays: the blocked actions
 * remain on screen, disabled, and this says why; the contact appears only when the operation configured one.
 * Nothing is shown for an agency out of trial.
 */
export function TrialNotice({ plan, now }: { plan: AgencyPlan; now?: Date }) {
  if (plan.kind !== 'trial' || plan.trialEndsAt === null) return null;
  if (plan.readOnly) {
    const contact = plan.supportContactEmail ?? null;
    return <section className="shell-notice trial-notice" aria-label="Plano">
      <CircleAlert className="shell-notice__icon" aria-hidden="true" />
      <p className="shell-notice__text" role="status">
        {AGENCY_READ_ONLY_TEXT}
        {contact !== null && <>{' '}Para renovar, escreva para <a href={`mailto:${contact}`}>{contact}</a>.</>}
      </p>
    </section>;
  }
  const days = trialDaysLeft(plan.trialEndsAt, now);
  return <section className="shell-notice trial-notice" aria-label="Período de teste">
    <Info className="shell-notice__icon" aria-hidden="true" />
    <p className="shell-notice__text" role="status">
      <strong>Período de teste: {days === 1 ? 'falta 1 dia' : `faltam ${days} dias`}</strong> (até {endDate(plan.trialEndsAt)}).
      {' '}Até lá, a agência tem até 3 clientes ativos, 3 colaboradores e 2 GB de mídia.
    </p>
  </section>;
}

/** The portal of an agency whose trial ended: the person reads everything and decides nothing. */
export function PortalReadOnlyNotice({ agencyName }: { agencyName: string }) {
  return <section className="shell-notice trial-notice" aria-label="Portal somente leitura">
    <CircleAlert className="shell-notice__icon" aria-hidden="true" />
    <p className="shell-notice__text" role="status">
      O plano de {agencyName} precisa ser renovado para aprovar, pedir ajustes e comentar. Tudo continua visível.
    </p>
  </section>;
}
