import { useState, type ReactNode } from 'react';
import { Plus } from 'lucide-react';

import type { StoryScriptListItem } from '@ageniza/contracts';
import { Button, EmptyState, Menu, MenuItem } from '@ageniza/ui';

import { fullDayLabel } from './content-dates.js';
import { StoryScriptModal, type StoryScriptTarget } from './story-script-modal.js';
import { StoryScriptStatusTag } from './story-script-status.js';

function StoryScriptDay({ day, scripts, canCreate, onOpen, onCreate, onCreateContent }: {
  day: string;
  scripts: readonly StoryScriptListItem[];
  canCreate: boolean;
  onOpen: (scriptId: string) => void;
  onCreate: (day: string) => void;
  onCreateContent: (day: string) => void;
}) {
  if (!canCreate && scripts.length === 0) return null;
  return <div className="content-day__tools">
    {canCreate && <Menu label="Adicionar ao dia" triggerLabel={`Adicionar no dia ${fullDayLabel(day)}`} trigger={<span aria-hidden="true">+</span>}>
      <MenuItem onClick={() => onCreateContent(day)}>Conteúdo</MenuItem>
      <MenuItem onClick={() => onCreate(day)}>Roteiro de stories</MenuItem>
    </Menu>}
    {scripts.length > 0 && <ul className="content-day__scripts">
      {scripts.map((script) => <li key={script.id}>
        <button type="button" className="content-day__script" aria-haspopup="dialog" onClick={() => onOpen(script.id)}>
          Stories · <StoryScriptStatusTag status={script.status} />
        </button>
      </li>)}
    </ul>}
  </div>;
}

/** Every script of the period in one place, so a script is reachable without hunting for its day in the grid. */
function StoryScriptList({ scripts, canCreate, today, onOpen, onCreate }: {
  scripts: readonly StoryScriptListItem[];
  canCreate: boolean;
  today: string;
  onOpen: (scriptId: string) => void;
  onCreate: (day: string) => void;
}) {
  const ordered = [...scripts].sort((a, b) => a.scriptOn.localeCompare(b.scriptOn));
  const create = canCreate
    ? <Button variant="secondary" leadingIcon={<Plus />} onClick={() => onCreate(today)}>Novo roteiro</Button>
    : undefined;
  return <section className="story-list" aria-labelledby="story-list-title">
    <div className="story-list__head">
      <h2 id="story-list-title" className="story-list__title">Roteiros de stories</h2>
      {ordered.length > 0 && create}
    </div>
    {ordered.length === 0
      ? <EmptyState
        headingLevel={3}
        title="Nenhum roteiro de stories neste período"
        description="Escreva as cenas do dia e envie ao cliente quando estiver pronto."
        action={create}
      />
      : <ul className="story-list__items">
        {ordered.map((script) => <li key={script.id} className="story-list__item">
          <time className="story-list__day" dateTime={script.scriptOn}>{fullDayLabel(script.scriptOn)}</time>
          <StoryScriptStatusTag status={script.status} />
          <Button variant="ghost" size="sm" aria-haspopup="dialog" aria-label={`Abrir o roteiro de ${fullDayLabel(script.scriptOn)}`} onClick={() => onOpen(script.id)}>Abrir</Button>
        </li>)}
      </ul>}
  </section>;
}

export interface StoryScriptLayer {
  /** What a day of the calendar carries for story scripts: the "+" for who operates, and a mark for each script. */
  readonly dayExtras: (day: string) => ReactNode;
  /** The scripts of the period as a list, with the way to write the first one. */
  readonly list: ReactNode;
  /** The script's modal, when one is open. */
  readonly modal: ReactNode;
}

/**
 * The story scripts on the calendar of one client. `canOperate` is `conteudo.operar` on a client that is
 * not archived: without it a script opens read-only and the "+" does not exist. It is UX only; the API
 * checks the permission on every write.
 */
export function useStoryScriptLayer({ clientId, canOperate, scripts, today, onCreateContent }: {
  clientId: string;
  canOperate: boolean;
  scripts: readonly StoryScriptListItem[];
  today: string;
  /** The "Conteúdo" option of the "+": the content modal belongs to the page, which opens it on that day. */
  onCreateContent: (day: string) => void;
}): StoryScriptLayer {
  // The target belongs to the client it was opened on: the same page shown for another client starts with no modal.
  const [opened, setOpened] = useState<{ readonly clientId: string; readonly target: StoryScriptTarget } | null>(null);
  const target = opened?.clientId === clientId ? opened.target : null;
  const byDay = new Map<string, StoryScriptListItem[]>();
  for (const script of scripts) byDay.set(script.scriptOn, [...(byDay.get(script.scriptOn) ?? []), script]);
  const open = (scriptId: string): void => setOpened({ clientId, target: { kind: 'open', scriptId } });
  const create = (day: string): void => setOpened({ clientId, target: { kind: 'new', day } });

  return {
    dayExtras: (day) => <StoryScriptDay
      day={day}
      scripts={byDay.get(day) ?? []}
      canCreate={canOperate}
      onOpen={open}
      onCreate={create}
      onCreateContent={onCreateContent}
    />,
    list: <StoryScriptList scripts={scripts} canCreate={canOperate} today={today} onOpen={open} onCreate={create} />,
    modal: target === null ? null : <StoryScriptModal
      key={target.kind === 'open' ? target.scriptId : `new-${target.day}`}
      clientId={clientId}
      target={target}
      canOperate={canOperate}
      onClose={() => setOpened(null)}
    />
  };
}
