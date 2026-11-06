/**
 * The agency's first achievements, each celebrated once (decision 2026-11-06). Which one was already celebrated is a
 * convenience of this browser, not a business rule, so it lives in `localStorage` and never reaches the API.
 */
export type MilestoneKey = 'client' | 'content' | 'sent' | 'approved' | 'published';

export type MilestoneFacts = Readonly<Record<MilestoneKey, boolean>>;

/** Highest first: when several are new at once, only the biggest is celebrated. */
export const MILESTONE_PRIORITY: readonly MilestoneKey[] = ['approved', 'published', 'sent', 'content', 'client'];

export const MILESTONE_MESSAGES: Readonly<Record<MilestoneKey, { title: string; text: string }>> = {
  approved: { title: 'Parabéns pela primeira aprovação!', text: 'Um cliente aprovou um conteúdo seu. É assim que o trabalho da agência passa a render.' },
  published: { title: 'Primeiro conteúdo postado!', text: 'Seu primeiro post foi para o ar. Parabéns!' },
  sent: { title: 'Primeiro conteúdo enviado para aprovação!', text: 'Agora é com o cliente. Parabéns pelo passo!' },
  content: { title: 'Primeiro conteúdo criado!', text: 'O calendário começou a ganhar forma. Parabéns!' },
  client: { title: 'Primeiro cliente cadastrado!', text: 'A carteira da agência começou. Parabéns!' }
};

const storageKey = (agencyId: string): string => `ageniza:milestones:${agencyId}`;

const readSeen = (storage: Storage, agencyId: string): readonly MilestoneKey[] | null => {
  const raw = storage.getItem(storageKey(agencyId));
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return MILESTONE_PRIORITY.filter((key) => parsed.includes(key));
};

/**
 * The milestone to celebrate now, or null. The first look at an agency in this browser only records what is already
 * done (so an agency that existed before this feature, or a new browser, is not congratulated for old news). Whatever
 * is recorded is never celebrated again. Without a working storage nothing is celebrated, since it could not be
 * remembered and would repeat on every visit.
 */
export const takeMilestone = (agencyId: string, facts: MilestoneFacts, storage: () => Storage = () => window.localStorage): MilestoneKey | null => {
  try {
    const store = storage();
    const seen = readSeen(store, agencyId);
    const done = MILESTONE_PRIORITY.filter((key) => facts[key]);
    store.setItem(storageKey(agencyId), JSON.stringify(done.concat((seen ?? []).filter((key) => !done.includes(key)))));
    if (seen === null) return null;
    return MILESTONE_PRIORITY.find((key) => facts[key] && !seen.includes(key)) ?? null;
  } catch {
    return null;
  }
};
