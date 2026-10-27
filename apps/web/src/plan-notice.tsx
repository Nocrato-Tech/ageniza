import { CircleAlert, Info } from 'lucide-react';

import type { AgencyPlan } from '@ageniza/contracts';

const DAY_MS = 86_400_000;

/** Whole days left, counting a started day as one: the trial that ends this afternoon still has 1 day. */
export const trialDaysLeft = (trialEndsAt: string, now: Date = new Date()): number =>
  Math.max(0, Math.ceil((Date.parse(trialEndsAt) - now.getTime()) / DAY_MS));

const endDate = (trialEndsAt: string): string =>
  new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', timeZone: 'America/Sao_Paulo' }).format(new Date(trialEndsAt));

export const AGENCY_READ_ONLY_TEXT = 'O período de teste terminou e a agência ficou somente leitura: tudo continua visível, mas nada pode ser criado, alterado ou enviado. Para continuar, fale com a equipe do Ageniza.';

/**
 * The top of the agency during and after the trial (issue #714). The database refuses the writes; this only says why
 * the actions are gone. Nothing is shown for an agency out of trial.
 */
export function TrialNotice({ plan, now }: { plan: AgencyPlan; now?: Date }) {
  if (plan.kind !== 'trial' || plan.trialEndsAt === null) return null;
  if (plan.readOnly) {
    return <section className="shell-notice trial-notice" aria-label="Período de teste">
      <CircleAlert className="shell-notice__icon" aria-hidden="true" />
      <p className="shell-notice__text" role="status"><strong>Somente leitura.</strong> {AGENCY_READ_ONLY_TEXT}</p>
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
      <strong>Somente leitura.</strong> Você continua vendo tudo, mas por enquanto não é possível aprovar, pedir ajustes nem comentar. Fale com {agencyName}.
    </p>
  </section>;
}
