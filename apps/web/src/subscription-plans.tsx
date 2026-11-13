import { Check } from 'lucide-react';

import type { SubscriptionPlansResponse } from '@ageniza/contracts';
import { Button, Pill } from '@ageniza/ui';

import { formatBrl, formatGb } from './subscription-format.js';

export type Plan = SubscriptionPlansResponse['plans'][number];

const RECOMMENDED_KEY = 'profissional';

const AUDIENCE: Record<string, string> = {
  essencial: 'Para quem está começando, com poucos clientes.',
  profissional: 'Para agências em crescimento, com mais clientes e mais mídia.',
  agencia: 'Para agências com uma carteira grande de clientes.'
};

/** What every plan has: unlimited collaborators and portal access (decision 2026-10-29) and the product as it ships. */
const INCLUDED = ['Calendário editorial', 'Portal de aprovação do cliente', 'App mobile', 'Colaboradores ilimitados', 'Acessos ao portal sem limite'];

/**
 * The price table: one card per plan, side by side, the recommended one highlighted. A card only asks to choose that plan;
 * no extras are offered here, they exist only after a plan is subscribed (decision 2026-11-06).
 */
export function PlanCards({ plans, currentKey, verb, blockedReason, busyKey, onChoose }: {
  plans: readonly Plan[];
  /** The plan the agency has now, marked on its card; absent while there is none. */
  currentKey?: string | undefined;
  verb: 'Assinar' | 'Escolher';
  blockedReason?: string | undefined;
  busyKey?: string | undefined;
  onChoose: (plan: Plan) => void;
}) {
  return <div className="plan-cards" role="group" aria-label="Planos">
    {plans.map((plan) => {
      const recommended = plan.key === RECOMMENDED_KEY;
      const current = plan.key === currentKey;
      return <article key={plan.key} className={['plan-card', recommended && 'plan-card--recommended'].filter(Boolean).join(' ')} aria-labelledby={`plan-${plan.key}`}>
        <div className="plan-card__tags">
          {recommended && <Pill tone="accent">Recomendado</Pill>}
          {current && <Pill>Seu plano</Pill>}
        </div>
        <h3 id={`plan-${plan.key}`} className="plan-card__name">{plan.name}</h3>
        <p className="plan-card__price"><span className="plan-card__amount">{formatBrl(plan.monthlyCents)}</span><span className="plan-card__period">/mês</span></p>
        <p className="plan-card__audience">{AUDIENCE[plan.key] ?? ''}</p>
        <ul className="plan-card__limits">
          <li><Check aria-hidden="true" />{plan.clientLimit} clientes ativos</li>
          <li><Check aria-hidden="true" />{formatGb(plan.storageBytes)} de armazenamento</li>
        </ul>
        <Button
          variant={recommended ? 'primary' : 'secondary'}
          disabled={current}
          loading={busyKey === plan.key}
          blockedReason={current ? undefined : blockedReason}
          onClick={() => { onChoose(plan); }}
        >{current ? 'Plano atual' : `${verb} ${plan.name}`}</Button>
      </article>;
    })}
  </div>;
}

export function PlanIncludes() {
  return <section className="plan-includes" aria-labelledby="plan-includes-title">
    <h2 id="plan-includes-title">Todos os planos incluem</h2>
    <ul>{INCLUDED.map((item) => <li key={item}><Check aria-hidden="true" />{item}</li>)}</ul>
  </section>;
}
