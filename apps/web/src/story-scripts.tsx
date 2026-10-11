import { useState, type ReactNode } from 'react';

import type { StoryScriptListItem } from '@ageniza/contracts';
import { Menu, MenuItem } from '@ageniza/ui';

import { fullDayLabel } from './content-dates.js';
import { STORY_SCRIPT_STATUS_LABELS, StoryScriptModal, type StoryScriptTarget } from './story-script-modal.js';

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
        <button type="button" className="content-day__script" data-status={script.status} aria-haspopup="dialog" onClick={() => onOpen(script.id)}>
          Stories · {STORY_SCRIPT_STATUS_LABELS[script.status]}
        </button>
      </li>)}
    </ul>}
  </div>;
}

export interface StoryScriptLayer {
  /** What a day of the calendar carries for story scripts: the "+" for who operates, and a mark for each script. */
  readonly dayExtras: (day: string) => ReactNode;
  /** The script's modal, when one is open. */
  readonly modal: ReactNode;
}

/**
 * The story scripts on the calendar of one client. `canOperate` is `conteudo.operar` on a client that is
 * not archived: without it a script opens read-only and the "+" does not exist. It is UX only; the API
 * checks the permission on every write.
 */
export function useStoryScriptLayer({ clientId, canOperate, scripts, onCreateContent }: {
  clientId: string;
  canOperate: boolean;
  scripts: readonly StoryScriptListItem[];
  /** The "Conteúdo" option of the "+": the content modal belongs to the page, which opens it on that day. */
  onCreateContent: (day: string) => void;
}): StoryScriptLayer {
  // The target belongs to the client it was opened on: the same page shown for another client starts with no modal.
  const [opened, setOpened] = useState<{ readonly clientId: string; readonly target: StoryScriptTarget } | null>(null);
  const target = opened?.clientId === clientId ? opened.target : null;
  const byDay = new Map<string, StoryScriptListItem[]>();
  for (const script of scripts) byDay.set(script.scriptOn, [...(byDay.get(script.scriptOn) ?? []), script]);

  return {
    dayExtras: (day) => <StoryScriptDay
      day={day}
      scripts={byDay.get(day) ?? []}
      canCreate={canOperate}
      onOpen={(scriptId) => setOpened({ clientId, target: { kind: 'open', scriptId } })}
      onCreate={(chosen) => setOpened({ clientId, target: { kind: 'new', day: chosen } })}
      onCreateContent={onCreateContent}
    />,
    modal: target === null ? null : <StoryScriptModal
      key={target.kind === 'open' ? target.scriptId : `new-${target.day}`}
      clientId={clientId}
      target={target}
      canOperate={canOperate}
      onClose={() => setOpened(null)}
    />
  };
}
