import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, CalendarX, Check, Database, KeyRound, LifeBuoy } from 'lucide-react';

import { Pill } from '@ageniza/ui';

import { formatBrl, formatMoney } from './subscription-format.js';
import { gib, perClientCents, photosOf, TRIAL_RECOMMENDED_KEY, type Plan } from './subscription-plans.js';
import { TRIAL_CLIENTS, TRIAL_COLLABORATORS, TRIAL_GIB } from './subscription-trial.js';

interface Column {
  key: string;
  label: string;
}

const yes = <Check aria-hidden="true" />;
const NO = '—';

/**
 * The direct comparison of the board: the trial and each plan side by side, from the plans the server sent plus the trial ceilings the
 * docs fix. The marked column is the one the cards recommend; on a narrow screen each row becomes a list with the column name in front.
 */
export function PlanComparison({ plans, recommendedKey }: { plans: readonly Plan[]; recommendedKey?: string | undefined }) {
  const ordered = [...plans].sort((a, b) => a.monthlyCents - b.monthlyCents);
  const marked = recommendedKey ?? TRIAL_RECOMMENDED_KEY;
  const columns: Column[] = [{ key: 'teste', label: 'Teste · 14 dias' }, ...ordered.map((plan) => ({ key: plan.key, label: plan.name }))];
  const forPlans = (render: (plan: Plan) => ReactNode): ReactNode[] => ordered.map(render);
  const rows: Array<{ label: string; price?: true; cells: ReactNode[] }> = [
    { label: 'Preço por mês', price: true, cells: ['Grátis', ...forPlans((plan) => formatBrl(plan.monthlyCents))] },
    { label: 'Clientes ativos', cells: [String(TRIAL_CLIENTS), ...forPlans((plan) => String(plan.clientLimit))] },
    { label: 'Armazenamento', cells: [`${TRIAL_GIB} GB`, ...forPlans((plan) => <>{gib(plan)} GB<small>cerca de {photosOf(plan)} fotos</small></>)] },
    { label: 'Custo por cliente, com o plano cheio', cells: [NO, ...forPlans((plan) => formatMoney(perClientCents(plan)))] },
    { label: 'Colaboradores', cells: [String(TRIAL_COLLABORATORS), ...forPlans(() => <>{yes}Ilimitados</>)] },
    { label: 'Acessos ao portal do cliente', cells: Array.from({ length: columns.length }, () => <>{yes}Sem limite</>) },
    { label: 'Calendário, aprovação por link e app', cells: Array.from({ length: columns.length }, () => yes) },
    { label: 'Extras (por cliente e por GB)', cells: [NO, ...forPlans(() => yes)] },
    { label: 'Quando o período acaba', cells: ['Somente leitura', ...forPlans(() => 'Renova todo mês')] }
  ];

  return <div className="cmp" role="table" aria-label="Comparação dos planos">
    <div className="cmp__row cmp__row--head" role="row">
      <span role="columnheader">O que muda</span>
      {columns.map((column) => <span key={column.key} role="columnheader" className={column.key === marked ? 'cmp__cell--rec' : undefined}>
        {column.label}
        {column.key === marked && <Pill tone="accent">Recomendado</Pill>}
      </span>)}
    </div>
    {rows.map((row) => <div key={row.label} className={['cmp__row', row.price && 'cmp__row--price'].filter(Boolean).join(' ')} role="row">
      <span role="rowheader">{row.label}</span>
      {columns.map((column, index) => {
        const cell = row.cells[index];
        return <span key={column.key} role="cell" data-plan={column.label} className={['cmp__cell', column.key === marked && 'cmp__cell--rec', cell === NO && 'cmp__cell--no'].filter(Boolean).join(' ')}><span>{cell}</span></span>;
      })}
    </div>)}
  </div>;
}

const PROOF = [
  { icon: <CalendarX aria-hidden="true" />, title: 'Cancele quando quiser, sem multa', text: 'Sem fidelidade. Você mantém tudo até o fim do período pago.' },
  { icon: <ArrowUpRight aria-hidden="true" />, title: 'Subir vale na hora', text: 'E você paga só os dias que faltam do período.' },
  { icon: <ArrowDownRight aria-hidden="true" />, title: 'Descer não cobra nada', text: 'Vale no próximo período e nunca abaixo do que você usa.' },
  { icon: <LifeBuoy aria-hidden="true" />, title: '3 dias de tolerância', text: 'Se um pagamento falhar, você continua escrevendo e vê o aviso com a data limite.' },
  { icon: <Database aria-hidden="true" />, title: 'Seus dados ficam guardados', text: 'Mesmo no somente leitura, nada é apagado.' },
  { icon: <KeyRound aria-hidden="true" />, title: 'Só a dona vê e muda a assinatura', text: 'Nenhum papel da equipe tem essa permissão.' }
];

export function PlanProof() {
  return <section aria-labelledby="prova-t">
    <div className="subscription__section-head"><h2 id="prova-t">Sem letra miúda</h2></div>
    <ul className="proof">
      {PROOF.map((item) => <li key={item.title}>{item.icon}<div><strong>{item.title}</strong><span>{item.text}</span></div></li>)}
    </ul>
  </section>;
}
