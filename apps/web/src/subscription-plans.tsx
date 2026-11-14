import { Check, HardDrive, Info, Layers, Sparkles, TrendingUp, TriangleAlert, Users } from 'lucide-react';

import type { SubscriptionOverviewResponse, SubscriptionPlansResponse } from '@ageniza/contracts';
import { Button, Pill } from '@ageniza/ui';

import { formatBrl, formatGb, formatMoney } from './subscription-format.js';

export type Plan = SubscriptionPlansResponse['plans'][number];
export type Subscription = NonNullable<SubscriptionOverviewResponse['subscription']>;

const GIB = 1024 ** 3;
/** Without usage data (a trial) the table has no basis to recommend: it keeps pointing at the middle plan. */
export const TRIAL_RECOMMENDED_KEY = 'profissional';
/** The share of the ceiling from which the next plan is the one to look at. */
export const NEAR_CEILING = 0.8;
export const POSTS_PER_CLIENT = 8;
export const MINUTES_PER_ROUND_TRIP = 10;
export const PHOTO_MB = 4;

/** Who each plan is for, in the words of the board; a plan the table does not know has no line. */
const COPY: Record<string, { tagline: string; fit: string }> = {
  essencial: { tagline: 'Aprovação por link para até 10 clientes', fit: 'Autônomo ou agência de 1 a 3 pessoas, com até 10 clientes ativos.' },
  profissional: { tagline: 'A carteira inteira, aprovada por link, sem contar vagas', fit: 'Agência de 3 a 10 pessoas, com 11 a 30 clientes ativos.' },
  agencia: { tagline: 'Para atender de 31 a 60 clientes sem comprar extra', fit: 'Agência com mais de 10 pessoas e de 31 a 60 clientes ativos.' }
};

/** What every plan has: unlimited collaborators and portal access (decision 2026-10-29) and the product as it ships. */
const INCLUDED = ['Calendário editorial', 'Portal de aprovação do cliente', 'App mobile', 'Colaboradores ilimitados', 'Acessos ao portal sem limite'];

export const gib = (plan: Plan): number => Math.round(plan.storageBytes / GIB);
export const perClientCents = (plan: Plan): number => Math.round(plan.monthlyCents / plan.clientLimit);
/** "5 mil", rounded to the nearest five thousand: the order of magnitude, not a promise. */
export const photosOf = (plan: Plan): string => `${Math.max(5, Math.round((plan.storageBytes / (PHOTO_MB * 1024 * 1024)) / 5000) * 5)} mil`;
export const cheapestPerClient = (plans: readonly Plan[]): Plan | undefined => [...plans].sort((a, b) => perClientCents(a) - perClientCents(b))[0];
const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

function unlocksOf(plan: Plan, previous: Plan | undefined): string[] {
  return [
    previous === undefined ? 'Calendário editorial e portal de aprovação, sem o cliente criar conta' : `Tudo do ${previous.name}`,
    previous === undefined ? `${plan.clientLimit} clientes ativos` : `${plan.clientLimit} clientes ativos: ${plan.clientLimit - previous.clientLimit} vagas a mais`,
    `${gib(plan)} GB: cerca de ${photosOf(plan)} fotos de ${PHOTO_MB} MB`,
    previous === undefined ? 'Colaboradores ilimitados' : 'Colaboradores e acessos ao portal ilimitados'
  ];
}

/** What a plan unlocks and who it is for, for the purchase screen to repeat. */
export function planSummary(plan: Plan, plans: readonly Plan[]): { tagline: string | undefined; unlocks: string[] } {
  const ordered = [...plans].sort((a, b) => a.monthlyCents - b.monthlyCents);
  const previous = ordered[ordered.findIndex((entry) => entry.key === plan.key) - 1];
  return { tagline: COPY[plan.key]?.tagline, unlocks: unlocksOf(plan, previous) };
}

/** A worked example that follows from the plan's own numbers; the screen says it is an illustration. */
function gainOf(plan: Plan, previous: Plan | undefined, plans: readonly Plan[], extraClientCents: number): { title: string; text: string } | undefined {
  const posts = plan.clientLimit * POSTS_PER_CLIENT;
  if (plan.key === 'essencial') {
    const hours = Math.round((posts * MINUTES_PER_ROUND_TRIP) / 60);
    return {
      title: `Cerca de ${hours} horas por mês de volta`,
      text: `${plan.clientLimit} clientes × ${POSTS_PER_CLIENT} posts = ${posts} posts aprovados por link. Se cada ida e volta no WhatsApp tomava ${MINUTES_PER_ROUND_TRIP} minutos, são ${hours} horas que sua equipe devolve ao trabalho de criação.`
    };
  }
  if (plan.key === 'profissional') {
    return {
      title: `${posts} posts por mês, a ${formatMoney(perClientCents(plan))} por cliente`,
      text: `${plan.clientLimit} clientes × ${POSTS_PER_CLIENT} posts = ${posts} posts aprovados por link. ${cheapestPerClient(plans)?.key === plan.key ? 'É o menor custo por cliente do catálogo, e a ' : 'A '}equipe cresce sem pagar mais.`
    };
  }
  if (plan.key === 'agencia' && previous !== undefined) {
    const extras = plan.clientLimit - previous.clientLimit;
    const withExtras = previous.monthlyCents + extras * extraClientCents;
    if (plan.monthlyCents <= withExtras) return undefined;
    return {
      title: `${gib(plan) - gib(previous)} GB a mais por ${formatBrl(plan.monthlyCents - withExtras)} a mais`,
      text: `Atender ${plan.clientLimit} clientes no ${previous.name} custaria ${formatBrl(previous.monthlyCents)} + ${extras} extras × ${formatBrl(extraClientCents)} = ${formatBrl(withExtras)}, com só ${gib(previous)} GB. No ${plan.name} são ${formatBrl(plan.monthlyCents)} e ${gib(plan)} GB.`
    };
  }
  return undefined;
}

export interface Recommendation {
  key: string;
  title: string;
  text: string;
  why: Array<{ icon: 'users' | 'storage' | 'trend'; text: string }>;
  /** True when the advice is to stay on the plan the agency has. */
  staying: boolean;
}

/**
 * The advice follows the use: stay while the clients are under 80% of the ceiling, look at the next plan from there. It exists only
 * for a subscription, which is the only case the screen knows the use of.
 */
export function recommend(plans: readonly Plan[], subscription: Subscription): Recommendation | undefined {
  const ordered = [...plans].sort((a, b) => a.monthlyCents - b.monthlyCents);
  const index = ordered.findIndex((plan) => plan.key === subscription.planKey);
  const current = ordered[index];
  if (current === undefined) return undefined;
  const next = ordered[index + 1];
  const ceiling = subscription.clientLimit;
  const share = subscription.usedClients / ceiling;
  const percent = Math.round(share * 100);
  const threshold = Math.floor(ceiling * NEAR_CEILING);
  const nearCeiling = share >= NEAR_CEILING && next !== undefined;
  const cheapest = cheapestPerClient(ordered)?.key === current.key;
  const today = subscription.usedClients > 0 ? `Hoje cada cliente ativo sai a ${formatMoney(Math.round(subscription.monthlyCents / subscription.usedClients))} por mês; ` : '';
  const full = `com a carteira cheia, o ${current.name} sai a ${formatMoney(Math.round(subscription.monthlyCents / ceiling))} por cliente${cheapest ? ' e é o plano de menor custo por cliente do catálogo' : ''}.`;
  const usage = `Você usa ${subscription.usedClients} de ${ceiling} clientes (${percent}%) e ${formatGb(subscription.usedBytes)} de ${formatGb(subscription.storageBytes)}. `;
  const tail = nearCeiling
    ? ` Você já passou de ${threshold} clientes, 80% do teto: o ${next.name} abre ${next.clientLimit} vagas.`
    : next === undefined ? '' : ` Quando você passar de ${threshold} clientes, 80% do teto, a recomendação muda para o ${next.name}.`;
  const why: Recommendation['why'] = [
    { icon: 'users', text: `${subscription.usedClients} de ${ceiling} clientes` },
    { icon: 'storage', text: `${formatGb(subscription.usedBytes)} de ${formatGb(subscription.storageBytes)}` },
    ...(next === undefined ? [] : [{ icon: 'trend' as const, text: `${next.name} vale ao passar de ${threshold}` }])
  ];
  return nearCeiling
    ? { key: next.key, title: `Passe para o ${next.name}: o ${current.name} está perto do teto`, text: `${usage}${today}${full}${tail}`, why, staying: false }
    : { key: current.key, title: `Fique no ${current.name}: ele cobre a sua carteira com folga`, text: `${usage}${today}${full}${tail}`, why, staying: true };
}

export function PlanRecommendation({ recommendation, onSeePlans }: { recommendation: Recommendation; onSeePlans: () => void }) {
  const icons = { users: <Users aria-hidden="true" />, storage: <HardDrive aria-hidden="true" />, trend: <TrendingUp aria-hidden="true" /> };
  return <section className="plan-rec" aria-labelledby="plan-rec-title">
    <p className="plan-rec__eyebrow">Recomendação para a sua agência</p>
    <h2 id="plan-rec-title" className="plan-rec__title">{recommendation.title}</h2>
    <p className="plan-rec__text">{recommendation.text}</p>
    <ul className="plan-rec__why">
      {recommendation.why.map((item) => <li key={item.text}>{icons[item.icon]}{item.text}</li>)}
    </ul>
    <div className="subscription__actions">
      <Button variant="secondary" leadingIcon={<Layers aria-hidden="true" />} onClick={onSeePlans}>Ver os três planos lado a lado</Button>
    </div>
  </section>;
}

/**
 * The price table: one card per plan, side by side, with what it unlocks, who it is for and an illustrated gain. A card only asks to
 * choose that plan; no extras are offered here, they exist only after a plan is subscribed (decision 2026-11-06).
 */
export function PlanCards({ plans, extraClientCents, currentKey, recommendedKey, usage, verb, blockedReason, busyKey, onChoose }: {
  plans: readonly Plan[];
  extraClientCents: number;
  /** The plan the agency has now, marked on its card; absent while there is none. */
  currentKey?: string | undefined;
  /** The plan the card highlights; absent: the table's own default. */
  recommendedKey?: string | undefined;
  /** What the agency uses now and the extras it has: a plan that cannot hold the clients says so instead of offering the button. */
  usage?: { clients: number; bytes: number; extraClients: number } | undefined;
  verb: 'Assinar' | 'Escolher';
  blockedReason?: string | undefined;
  busyKey?: string | undefined;
  onChoose: (plan: Plan) => void;
}) {
  const ordered = [...plans].sort((a, b) => a.monthlyCents - b.monthlyCents);
  const highlighted = recommendedKey ?? TRIAL_RECOMMENDED_KEY;
  const currentIndex = ordered.findIndex((plan) => plan.key === currentKey);
  return <div className="plan-cards" role="group" aria-label="Planos">
    {ordered.map((plan, index) => {
      const recommended = plan.key === highlighted;
      const current = plan.key === currentKey;
      const previous = ordered[index - 1];
      const copy = COPY[plan.key];
      const gain = gainOf(plan, previous, ordered, extraClientCents);
      const tooSmall = usage !== undefined && !current && usage.clients > plan.clientLimit + usage.extraClients;
      const later = currentIndex >= 0 && index === currentIndex + 1 && !recommended && !tooSmall;
      return <article key={plan.key} className={['plan-card', recommended && 'plan-card--recommended'].filter(Boolean).join(' ')} aria-labelledby={`plan-${plan.key}`}>
        <div className="plan-card__tags">
          {recommended && <Pill tone="accent" icon={<Sparkles aria-hidden="true" />}>Recomendado</Pill>}
          {current && <Pill>Seu plano</Pill>}
        </div>
        <h3 id={`plan-${plan.key}`} className="plan-card__name">{plan.name}</h3>
        {copy !== undefined && <p className="plan-card__tagline">{copy.tagline}</p>}
        <div>
          <p className="plan-card__price"><span className="plan-card__amount">{formatBrl(plan.monthlyCents)}</span><span className="plan-card__period">/mês</span></p>
          <p className="plan-card__per">{formatMoney(perClientCents(plan))} por cliente com o plano cheio</p>
        </div>
        {copy !== undefined && <div className="plan-card__section"><p className="plan-card__label">Para quem é</p><p>{copy.fit}</p></div>}
        <div className="plan-card__section">
          <p className="plan-card__label">O que destrava</p>
          <ul className="plan-card__limits">{unlocksOf(plan, previous).map((item) => <li key={item}><Check aria-hidden="true" />{item}</li>)}</ul>
        </div>
        {gain !== undefined && <div className="plan-card__gain"><strong><TrendingUp aria-hidden="true" />{gain.title}</strong><span>{gain.text}</span><small>Exemplo ilustrativo.</small></div>}
        {tooSmall && usage !== undefined && <p className="plan-card__note plan-card__note--warn"><TriangleAlert aria-hidden="true" />Não cabe hoje: você tem {plural(usage.clients, 'cliente ativo', 'clientes ativos')} e {formatGb(usage.bytes)}.</p>}
        {later && usage !== undefined && <p className="plan-card__note"><Info aria-hidden="true" />Passa a valer ao passar de {Math.floor(((ordered[currentIndex]?.clientLimit ?? 0) + usage.extraClients) * NEAR_CEILING)} clientes.</p>}
        <Button
          variant={recommended && currentKey === undefined ? 'primary' : 'secondary'}
          disabled={current || tooSmall}
          loading={busyKey === plan.key}
          blockedReason={current || tooSmall ? undefined : blockedReason}
          onClick={() => { onChoose(plan); }}
        >{current ? 'Plano atual' : tooSmall && usage !== undefined ? `Não cabe: ${plural(usage.clients, 'cliente ativo', 'clientes ativos')}` : `${verb} ${plan.name}`}</Button>
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
