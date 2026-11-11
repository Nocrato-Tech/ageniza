import { useEffect, useRef } from 'react';
import { Check, Clock } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';

import { Pill } from '@ageniza/ui';

import { awaitingOf, type AwaitingCounts } from './brand-study-conversation.js';
import { SECTION_LABELS, SECTION_ORDER, sectionSearch, type SectionKey } from './brand-study-model.js';

/**
 * The seven sections as links, one column on a wide screen and a row that scrolls sideways on a narrow one.
 * Each says whether it is filled (icon and a word for assistive technology, never only a colour) and how many
 * conversations wait for the agency. The open one is `aria-current`; the link keeps the roster's address in `state`.
 */
export function SectionIndex({ active, filled, awaiting }: {
  active: SectionKey;
  filled: Readonly<Record<SectionKey, boolean>>;
  awaiting: AwaitingCounts;
}) {
  const location = useLocation();
  const listRef = useRef<HTMLUListElement>(null);
  // The counts arrive after the first paint and widen the links before the open one: centre it again when they do.
  const widths = SECTION_ORDER.map((key) => awaitingOf(key, awaiting) ?? '-').join(',');

  // On a narrow screen the row scrolls: bring the open section into view without moving the page.
  useEffect(() => {
    const list = listRef.current;
    const current = list?.querySelector<HTMLElement>('[aria-current="page"]');
    if (list === null || list === undefined || current === null || current === undefined || list.scrollWidth <= list.clientWidth) return;
    const offset = current.getBoundingClientRect().left - list.getBoundingClientRect().left + list.scrollLeft;
    list.scrollLeft = offset - (list.clientWidth - current.offsetWidth) / 2;
  }, [active, widths]);

  return <nav className="brand-index" aria-label="Seções do estudo de marca">
    <ul className="brand-index__list" ref={listRef}>
      {SECTION_ORDER.map((key) => {
        const pending = awaitingOf(key, awaiting);
        return <li key={key}>
          <Link
            className="brand-index__link"
            to={{ search: sectionSearch(key) }}
            state={location.state}
            aria-current={key === active ? 'page' : undefined}
          >
            <span className={`brand-index__dot brand-index__dot--${filled[key] ? 'done' : 'open'}`} aria-hidden="true">{filled[key] && <Check />}</span>
            <span className="brand-index__label">{SECTION_LABELS[key]}</span>
            <span className="visually-hidden">{filled[key] ? ' preenchida' : ' não preenchida'}</span>
            {pending !== undefined && pending > 0 && <Pill icon={<Clock />} className="brand-index__awaiting">{pending} aguardando</Pill>}
          </Link>
        </li>;
      })}
    </ul>
  </nav>;
}
