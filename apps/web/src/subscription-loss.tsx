import type { ReactNode } from 'react';
import { ArrowDown, Check, Gauge, Lock, LogOut, Users, X } from 'lucide-react';

import { formatBrl, formatGb, formatInstant } from './subscription-format.js';
import { gib, NEAR_CEILING, type Plan, type Subscription } from './subscription-plans.js';
import { TRIAL_CLIENTS, TRIAL_GIB } from './subscription-trial.js';

const GIB = 1024 ** 3;
/** The clients the board uses to price an extra against the next plan. */
const EXTRA_EXAMPLE = 5;

type Item = { text: string; good?: boolean };

function Loss({ icon, title, items, fix }: { icon: ReactNode; title: string; items: Item[]; fix: string }) {
  return <div className="loss__card" role="group" aria-label={title}>
    <h3>{icon}{title}</h3>
    <ul className="loss__list">
      {items.map((item) => <li key={item.text}>{item.good === true ? <Check aria-hidden="true" className="loss__ok" /> : <X aria-hidden="true" />}{item.text}</li>)}
    </ul>
    <p className="loss__fix">{fix}</p>
  </div>;
}

const clientsText = (count: number): string => `${count} ${count === 1 ? 'cliente' : 'clientes'}`;

/**
 * "O que você perde, em números" of a subscriber. Every number is the use and the plans the server sent: the lower plan's ceiling with
 * the agency's extras, the clients and the period end. What the API does not send (posts in flight) is not shown.
 */
function SubscriberLosses({ plans, subscription, extraClientCents }: { plans: readonly Plan[]; subscription: Subscription; extraClientCents: number }) {
  const ordered = [...plans].sort((a, b) => a.monthlyCents - b.monthlyCents);
  const index = ordered.findIndex((plan) => plan.key === subscription.planKey);
  const current = ordered[index];
  const lower = ordered[index - 1];
  const next = ordered[index + 1];
  const end = subscription.currentPeriodEnd === null ? undefined : formatInstant(subscription.currentPeriodEnd);
  const ceiling = subscription.clientLimit;
  const room = ceiling - subscription.usedClients;
  const warnAt = Math.floor(ceiling * NEAR_CEILING);

  const cards: ReactNode[] = [];
  if (current !== undefined && lower !== undefined) {
    const clientCeiling = lower.clientLimit + subscription.extraClients;
    const bytesCeiling = lower.storageBytes + subscription.extraStorageGib * GIB;
    const clientExcess = Math.max(0, subscription.usedClients - clientCeiling);
    const bytesExcess = Math.max(0, subscription.usedBytes - bytesCeiling);
    const saving = formatBrl(current.monthlyCents - lower.monthlyCents);
    cards.push(<Loss key="down" icon={<ArrowDown aria-hidden="true" />} title={`Baixar para o ${lower.name}`}
      items={[
        clientExcess > 0
          ? { text: `Você tem ${clientsText(subscription.usedClients)} ativos e o ${lower.name} comporta ${clientCeiling}: seria preciso arquivar ${clientsText(clientExcess)} antes.` }
          : { text: `Você tem ${clientsText(subscription.usedClients)} ativos e o ${lower.name} comporta ${clientCeiling}: cabe.`, good: true },
        bytesExcess > 0
          ? { text: `Você guarda ${formatGb(subscription.usedBytes)} e o ${lower.name} comporta ${gib(lower) + subscription.extraStorageGib} GB: seria preciso liberar ${formatGb(bytesExcess)}.` }
          : { text: `Você guarda ${formatGb(subscription.usedBytes)} e o ${lower.name} comporta ${gib(lower) + subscription.extraStorageGib} GB: cabe.`, good: true },
        { text: clientExcess > 0 ? `Economia de ${saving} por mês, contra ${clientsText(clientExcess)} fora da operação.` : `Economia de ${saving} por mês.` }
      ]}
      fix={`A descida só vale no próximo período${end === undefined ? '' : ` (${end})`} e nunca abaixo do uso: o sistema recusa enquanto não couber.`} />);
  }
  cards.push(<Loss key="ceiling" icon={<Gauge aria-hidden="true" />} title={`Chegar ao teto de ${ceiling}`}
    items={[
      { text: `No ${ceiling + 1}º cliente ativo, o cadastro é recusado até você subir de plano, comprar extra ou arquivar um cliente.` },
      { text: room > 0 ? `Sobram ${room} ${room === 1 ? 'vaga' : 'vagas'} hoje.${next === undefined ? '' : ` Passando de ${warnAt}, a recomendação muda para o ${next.name}.`}` : 'Não sobra vaga hoje.' }
    ]}
    fix={`Para ${EXTRA_EXAMPLE} clientes a mais, o extra custa ${formatBrl(EXTRA_EXAMPLE * extraClientCents)} por mês.${next === undefined || current === undefined ? '' : ` Para o ${next.name}, ${formatBrl(next.monthlyCents - current.monthlyCents)} a mais.`}`} />);
  cards.push(<Loss key="cancel" icon={<LogOut aria-hidden="true" />} title="Cancelar a assinatura"
    items={[
      { text: `${end === undefined ? 'No fim do período' : `Em ${end}`} a agência entra no somente leitura: ${clientsText(subscription.usedClients)} ativos ficam sem edição.` },
      { text: 'Até lá você mantém tudo. Dá para desfazer o cancelamento com um clique antes do fim.', good: true }
    ]}
    fix="Os dados ficam guardados. Para voltar depois, basta assinar de novo." />);
  return <>{cards}</>;
}

function TrialLosses({ plans, trialEndsAt, ended }: { plans: readonly Plan[]; trialEndsAt: string | null; ended: boolean }) {
  const first = [...plans].sort((a, b) => a.monthlyCents - b.monthlyCents)[0];
  return <>
    <Loss icon={<Lock aria-hidden="true" />} title={ended ? 'O teste acabou' : 'Deixar o teste acabar'}
      items={[
        { text: ended || trialEndsAt === null ? 'A agência está no somente leitura: ninguém cria nem edita conteúdo.' : `Em ${formatInstant(trialEndsAt)} a agência entra no somente leitura: ninguém cria nem edita conteúdo.` },
        { text: 'Os conteúdos que esperam a aprovação dos clientes ficam parados no meio do caminho.' }
      ]}
      fix="Nada é apagado: os dados ficam guardados e voltam a ser editáveis assim que você assinar." />
    <Loss icon={<Users aria-hidden="true" />} title={`Passar de ${TRIAL_CLIENTS} clientes`}
      items={[
        { text: `O teste comporta ${TRIAL_CLIENTS} clientes ativos: o ${TRIAL_CLIENTS + 1}º cliente não entra.` },
        { text: `O teste guarda ${TRIAL_GIB} GB de mídia.` }
      ]}
      fix={first === undefined ? 'Os planos abrem mais clientes e mais mídia.' : `O ${first.name} abre ${first.clientLimit} clientes e ${gib(first)} GB por ${formatBrl(first.monthlyCents)} por mês.`} />
  </>;
}

export function PlanLosses({ plans, extraClientCents, subscription, trial }: {
  plans: readonly Plan[];
  extraClientCents: number;
  subscription: Subscription | null;
  trial: { trialEndsAt: string | null; ended: boolean };
}) {
  return <section aria-labelledby="perdas-t" id="perdas">
    <div className="subscription__section-head">
      <h2 id="perdas-t" tabIndex={-1}>O que você perde, em números</h2>
      <p className="subscription__muted">{subscription === null
        ? 'Antes de deixar o teste acabar, veja o que fica parado na sua agência.'
        : 'Antes de descer de plano ou cancelar, veja o que fica para trás na sua agência.'}</p>
    </div>
    <div className="loss">
      {subscription === null
        ? <TrialLosses plans={plans} trialEndsAt={trial.trialEndsAt} ended={trial.ended} />
        : <SubscriberLosses plans={plans} subscription={subscription} extraClientCents={extraClientCents} />}
    </div>
  </section>;
}
