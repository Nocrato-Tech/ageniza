import type { StoryScript } from '@ageniza/contracts';
import { StatusTag, type StatusTagStatus } from '@ageniza/ui';

export const STORY_SCRIPT_STATUS_LABELS: Readonly<Record<StoryScript['status'], string>> = {
  draft: 'Rascunho',
  sent: 'Enviado',
  recorded: 'Gravado'
};

/** One icon shape per state (empty circle, clock, check), so the three are told apart by form and by word, never by colour. */
const STORY_SCRIPT_STATUS_TAGS: Readonly<Record<StoryScript['status'], StatusTagStatus>> = {
  draft: 'production',
  sent: 'waiting',
  recorded: 'ready'
};

export function StoryScriptStatusTag({ status }: { status: StoryScript['status'] }) {
  return <StatusTag status={STORY_SCRIPT_STATUS_TAGS[status]}>{STORY_SCRIPT_STATUS_LABELS[status]}</StatusTag>;
}
