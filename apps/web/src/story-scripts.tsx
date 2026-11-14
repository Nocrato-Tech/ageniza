import { useState, type ReactNode } from 'react';
import { Plus } from 'lucide-react';

import type { StoryScriptListItem } from '@ageniza/contracts';
import { Menu, MenuItem } from '@ageniza/ui';

import { fullDayLabel, weekdayShortLabel } from './content-dates.js';
import { StoryScriptModal, type StoryScriptTarget } from './story-script-modal.js';
import { STORY_SCRIPT_STATUS_LABELS } from './story-script-status.js';

const scenesLabel = (count: number): string => `${count} ${count === 1 ? 'cena' : 'cenas'}`;

/** The circle of a script: its day (or its scenes) inside a ring that is dashed for a draft, violet for a sent script and teal for a recorded one. */
function StoryRing({ status, children }: { status: StoryScriptListItem['status'] | 'new'; children: ReactNode }) {
  return <span className="story-ring" data-status={status} aria-hidden="true"><span className="story-ring__in">{children}</span></span>;
}

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
    {scripts.map((script) => <button key={script.id} type="button" className="content-day__story" data-status={script.status} aria-haspopup="dialog" onClick={() => onOpen(script.id)}>
      <StoryRing status={script.status}>{script.sceneCount}</StoryRing>
      <span className="content-day__story-text">Stories{' '}<small>{scenesLabel(script.sceneCount)} · {STORY_SCRIPT_STATUS_LABELS[script.status]}</small></span>
    </button>)}
  </div>;
}

/** The circles at the top of the feed's profile, in the place the destaques have on Instagram: the day, and the state in words. */
export function StoryScriptCircles({ scripts, onOpen }: { scripts: readonly StoryScriptListItem[]; onOpen: (scriptId: string) => void }) {
  const ordered = [...scripts].sort((a, b) => a.scriptOn.localeCompare(b.scriptOn));
  if (ordered.length === 0) return null;
  return <ul className="content-feed__stories" aria-label="Stories do mês">
    {ordered.map((script) => <li key={script.id}>
      <button type="button" className="content-feed__story" data-status={script.status} aria-haspopup="dialog" onClick={() => onOpen(script.id)}>
        <StoryRing status={script.status}>{Number(script.scriptOn.slice(8, 10))}</StoryRing>
        <span>{STORY_SCRIPT_STATUS_LABELS[script.status]}</span>
        <span className="visually-hidden">Stories do dia {fullDayLabel(script.scriptOn)}</span>
      </button>
    </li>)}
  </ul>;
}

/** "Stories do mês": every script of the period as a circle, so a script is reachable without hunting for its day in the grid, and "Novo" opens a script on today. */
function StoryScriptStrip({ scripts, canCreate, today, scope, onOpen, onCreate }: {
  scripts: readonly StoryScriptListItem[];
  canCreate: boolean;
  today: string;
  scope: string;
  onOpen: (scriptId: string) => void;
  onCreate: (day: string) => void;
}) {
  const ordered = [...scripts].sort((a, b) => a.scriptOn.localeCompare(b.scriptOn));
  return <section className="story-list" aria-labelledby="story-list-title">
    <h2 id="story-list-title" className="story-list__title">Stories {scope}</h2>
    {ordered.length === 0 && <p className="story-list__none">Nenhum roteiro de stories neste período.</p>}
    {(canCreate || ordered.length > 0) && <ul className="story-list__items">
      {canCreate && <li className="story-list__item" data-status="new">
        <button type="button" className="story-list__open" aria-haspopup="dialog" aria-label="Novo roteiro de stories" onClick={() => onCreate(today)}>
          <StoryRing status="new"><Plus /></StoryRing>
          <span className="story-list__when">Novo</span>
        </button>
      </li>}
      {ordered.map((script) => <li key={script.id} className="story-list__item" data-status={script.status}>
        <button type="button" className="story-list__open" aria-haspopup="dialog" onClick={() => onOpen(script.id)}>
          <StoryRing status={script.status}>{Number(script.scriptOn.slice(8, 10))}</StoryRing>
          <span className="story-list__when">{weekdayShortLabel(script.scriptOn)} {Number(script.scriptOn.slice(8, 10))}</span>
          <span className="story-list__state">{scenesLabel(script.sceneCount)} · {STORY_SCRIPT_STATUS_LABELS[script.status]}</span>
        </button>
      </li>)}
    </ul>}
    <ul className="story-list__legend" aria-label="Legenda dos roteiros">
      <li><span className="story-ring story-ring--legend" data-status="draft" aria-hidden="true" />Rascunho</li>
      <li><span className="story-ring story-ring--legend" data-status="sent" aria-hidden="true" />Enviado ao cliente</li>
      <li><span className="story-ring story-ring--legend" data-status="recorded" aria-hidden="true" />Gravado</li>
    </ul>
  </section>;
}

export interface StoryScriptLayer {
  /** What a day of the calendar carries for story scripts: the "+" for who operates, and a mark for each script. */
  readonly dayExtras: (day: string) => ReactNode;
  /** The scripts of the period as a list, with the way to write the first one. */
  readonly list: ReactNode;
  /** Opens the modal of a script, for the feed's own circles. */
  readonly open: (scriptId: string) => void;
  /** The script's modal, when one is open. */
  readonly modal: ReactNode;
}

/**
 * The story scripts on the calendar of one client. `canOperate` is `conteudo.operar` on a client that is
 * not archived: without it a script opens read-only and the "+" does not exist. It is UX only; the API
 * checks the permission on every write.
 */
export function useStoryScriptLayer({ clientId, canOperate, scripts, today, scope, onCreateContent }: {
  clientId: string;
  canOperate: boolean;
  scripts: readonly StoryScriptListItem[];
  today: string;
  /** What the strip says it covers: "do mês" or "da semana". */
  scope: string;
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
    list: <StoryScriptStrip scripts={scripts} canCreate={canOperate} today={today} scope={scope} onOpen={open} onCreate={create} />,
    open,
    modal: target === null ? null : <StoryScriptModal
      key={target.kind === 'open' ? target.scriptId : `new-${target.day}`}
      clientId={clientId}
      target={target}
      canOperate={canOperate}
      onClose={() => setOpened(null)}
    />
  };
}
