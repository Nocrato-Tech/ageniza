import { useEffect, useState, type CSSProperties } from 'react';
import { PartyPopper, X } from 'lucide-react';

import { IconButton, MilestoneTrail, Stage3D, type MilestoneStep } from '@ageniza/ui';

import type { ActivationSteps } from './activation-path.js';
import { instantLabel } from './home-dates.js';
import { MILESTONE_MESSAGES, takeMilestone, type MilestoneFacts, type MilestoneKey } from './milestones.js';

/** The brand and the two warm tones of the celebration (docs/design-system.md, "Marco e recompensa"). */
const COLORS = ['--color-indigo-600', '--color-violet-600', '--color-teal-500', '--celebration-gold', '--celebration-coral'] as const;

/** Deterministic spread, so the confetti is the same on every render and in every test. */
const pieces = (count: number): CSSProperties[] => Array.from({ length: count }, (_, index) => ({
  '--confetti-x': `${(index * 37) % 100}vw`,
  '--confetti-drift': `${((index * 53) % 21) - 10}vw`,
  '--confetti-delay': `${(index % 8) * 90}ms`,
  '--confetti-color': `var(${COLORS[index % COLORS.length]})`
}) as CSSProperties);

const prefersReducedMotion = (): boolean => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

/** Falls on top of the screen without catching a click or a key; gone by itself after a few seconds. */
function Confetti({ count, onDone, lasts }: { count: number; onDone: () => void; lasts: number }) {
  useEffect(() => {
    const timer = window.setTimeout(onDone, lasts);
    return () => { window.clearTimeout(timer); };
  }, [onDone, lasts]);
  return <div className="confetti" aria-hidden="true" data-testid="confetti">
    {pieces(count).map((style, index) => <span key={index} className="confetti__piece" style={style} />)}
  </div>;
}

/**
 * Celebrates the agency's newest first achievement, once (decision 2026-11-06): the first approval with a panel and a big
 * confetti, the others with a lighter toast and a short confetti. With reduced motion there is the message and no confetti.
 * `facts` is undefined while they load, so nothing is decided before they are known.
 */
export function MilestoneCelebration({ agencyId, facts }: { agencyId: string; facts: MilestoneFacts | undefined }) {
  const [milestone, setMilestone] = useState<MilestoneKey | null>(null);
  const [confetti, setConfetti] = useState(false);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (facts === undefined) return;
    const next = takeMilestone(agencyId, facts);
    if (next === null) return;
    setMilestone(next);
    setVisible(true);
    setConfetti(!prefersReducedMotion());
  }, [agencyId, facts]);

  const big = milestone === 'approved';
  const toast = milestone !== null && !big;
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => { setVisible(false); }, 6000);
    return () => { window.clearTimeout(timer); };
  }, [toast, milestone]);

  if (milestone === null) return null;
  const { title, text } = MILESTONE_MESSAGES[milestone];
  return <>
    {confetti && <Confetti count={big ? 90 : 28} lasts={big ? 5000 : 2500} onDone={() => { setConfetti(false); }} />}
    {visible && <div className={toast ? 'milestone milestone--toast' : 'milestone'} role="status" data-milestone={milestone}>
      <PartyPopper className="milestone__icon" aria-hidden="true" />
      <div className="milestone__text">
        <strong>{title}</strong>
        <span>{text}</span>
      </div>
      <IconButton label="Fechar" icon={<X />} onClick={() => { setVisible(false); }} />
    </div>}
  </>;
}

const MILESTONE_ORDER: readonly MilestoneKey[] = ['client', 'content', 'sent', 'approved', 'published'];

const MILESTONE_TITLES: Readonly<Record<MilestoneKey, string>> = {
  client: 'Primeiro cliente cadastrado',
  content: 'Primeiro conteúdo criado',
  sent: 'Primeiro envio para aprovação',
  approved: 'Primeira aprovação',
  published: 'Primeiro conteúdo postado'
};

const MILESTONE_STATUS_LABELS = { done: 'Conquistado', current: 'Passo atual', upcoming: 'A conquistar' } as const;

/** "3 de novembro · Padaria Central": the day and the name that go with a milestone already reached. */
const whenOf = (key: MilestoneKey, steps: ActivationSteps | undefined): string | undefined => {
  if (steps === undefined) return undefined;
  const step = { client: steps.firstClient, content: steps.firstContent, sent: steps.firstSent, approved: steps.firstApproved, published: null }[key];
  return step === null ? undefined : `${instantLabel(step.at)} · ${step.name}`;
};

/**
 * "Marcos da agência": the five first achievements on the compact trail, in the order they come, each with its day and name. The approval,
 * while missing, says whose answer is the only thing left. It says nothing before the facts are known and nothing
 * before the first one is reached, since the journey above already shows the whole way to a new agency.
 */
export function AgencyMilestones({ facts, steps: stepFacts }: { facts: MilestoneFacts | undefined; steps?: ActivationSteps | undefined }) {
  if (facts === undefined || !MILESTONE_ORDER.some((key) => facts[key])) return null;
  const steps: MilestoneStep[] = MILESTONE_ORDER.map((key) => ({
    id: key,
    title: MILESTONE_TITLES[key],
    status: facts[key] ? 'done' : 'upcoming',
    when: whenOf(key, stepFacts),
    description: key === 'approved' && stepFacts?.firstSent != null ? `Falta só a resposta de ${stepFacts.firstSent.name}.` : undefined
  }));
  return <section className="agency-milestones" aria-labelledby="agency-milestones-title" data-stage-host>
    <div className="agency-milestones__head">
      <h2 id="agency-milestones-title" className="agency-milestones__title">Marcos da agência</h2>
      <Stage3D src="/3d/medal.png" tone="indigo" size="sm" />
    </div>
    <MilestoneTrail size="sm" steps={steps} statusLabels={MILESTONE_STATUS_LABELS} aria-label="Marcos da agência" />
  </section>;
}
