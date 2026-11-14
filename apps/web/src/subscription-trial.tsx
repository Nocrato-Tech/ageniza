import { CalendarClock, CreditCard, Hourglass, Receipt, Users } from 'lucide-react';

import { formatInstant } from './subscription-format.js';

/** The ceilings of the free trial, fixed by the docs (agencia.md, "Teste grátis"): the API does not send them. */
export const TRIAL_DAYS = 14;
export const TRIAL_CLIENTS = 3;
export const TRIAL_COLLABORATORS = 3;
export const TRIAL_GIB = 2;

/**
 * "Seu plano" of an agency in the trial: what the trial is and when it ends, and that nothing is charged by itself. The API sends no
 * use for a trial, so there are no meters here; the card and the invoices say what comes with the first subscription.
 */
export function TrialPlan({ trialEndsAt, daysLeft, ended }: { trialEndsAt: string | null; daysLeft: number | null; ended: boolean }) {
  const day = daysLeft === null ? null : Math.min(TRIAL_DAYS, Math.max(1, TRIAL_DAYS - daysLeft));
  const limits = `${TRIAL_CLIENTS} clientes · ${TRIAL_GIB} GB`;
  return <div className="subscription__split">
    <section className="subscription__block subscription__block--card" aria-labelledby="subscription-current">
      <div className="subscription__current-head">
        <div>
          <h2 id="subscription-current">Seu plano</h2>
          <p className="subscription__muted">{ended ? 'O teste gratuito acabou.' : day === null ? `Teste gratuito de ${TRIAL_DAYS} dias.` : `Teste gratuito de ${TRIAL_DAYS} dias, no dia ${day}.`}</p>
        </div>
        {daysLeft !== null && <span className="subscription__chip subscription__chip--waiting"><Hourglass aria-hidden="true" />{ended ? 'Somente leitura' : daysLeft === 1 ? '1 dia restante' : `${daysLeft} dias restantes`}</span>}
      </div>
      <p className="subscription__price">
        <span className="subscription__stat">Grátis</span>
        <span className="subscription__muted">{trialEndsAt === null ? limits : `${ended ? 'acabou em' : 'até'} ${formatInstant(trialEndsAt)} · ${limits}`}</span>
      </p>
      <ul className="subscription__facts">
        <li className="subscription__fact"><CalendarClock aria-hidden="true" />Nada é cobrado sozinho: você só paga quando assinar.</li>
        <li className="subscription__fact"><Users aria-hidden="true" />Colaboradores: até {TRIAL_COLLABORATORS} no teste, contando você. Nos planos pagos, sem limite, assim como os acessos ao portal.</li>
      </ul>
    </section>
    <section className="subscription__block subscription__block--card" aria-labelledby="subscription-billing">
      <h2 id="subscription-billing">Cartão e cobranças</h2>
      <div className="subscription-test-card">
        <span className="subscription-test-card__icon" aria-hidden="true"><CreditCard /></span>
        <span className="subscription-test-card__main"><strong>Nenhum cartão ainda</strong><span>Você cadastra na hora de assinar</span></span>
      </div>
      <div className="subscription-test-card">
        <span className="subscription-test-card__icon" aria-hidden="true"><Receipt /></span>
        <span className="subscription-test-card__main"><strong>Faturas</strong><span>Aparecem depois da primeira cobrança</span></span>
      </div>
    </section>
  </div>;
}
