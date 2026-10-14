import type { ReactNode } from 'react';

import { Avatar } from './avatar.js';
import { Realce } from './realce.js';

export interface ClientStripItem {
  readonly id: string;
  readonly name: string;
  readonly photoUrl?: string | null;
  /** Why something of this client asks for action ("em ajuste", "em atraso"); any entry draws the ring and is read aloud. */
  readonly attention?: readonly string[];
  /** Where the client opens; needed unless the strip is given `renderLink`. */
  readonly href?: string;
}

/** What `renderLink` must spread on the link it draws, so the strip keeps its look, its name and its current marker. */
export interface ClientStripLinkProps {
  className: string;
  'aria-current': 'page' | undefined;
  'aria-label': string | undefined;
  children: ReactNode;
}

export interface ClientStripProps {
  /** Names the navigation for assistive technology ("Clientes"). */
  label: string;
  items: readonly ClientStripItem[];
  /** The client the screen is on: its name takes the highlighter and its link is `aria-current`. */
  selectedId?: string;
  /** Draws each link with the router's `Link` (or any component), keeping the state the screen carries forward. */
  renderLink?: (item: ClientStripItem, link: ClientStripLinkProps) => ReactNode;
  className?: string;
}

/**
 * The clients as stories: photo or initials and the name, in the order given. It is navigation, so each client is a real link
 * and the one you are on says so with `aria-current` and the highlighter, never by colour alone. A ring on the photo says
 * something of that client asks for action, and its reasons are part of the link's name, after the client's own.
 */
export function ClientStrip({ label, items, selectedId, renderLink, className }: ClientStripProps) {
  return (
    <nav aria-label={label} className={['ui-client-strip', className].filter(Boolean).join(' ')}>
      <ul className="ui-client-strip__list">
        {items.map((item) => {
          const reasons = (item.attention ?? []).join(', ');
          const selected = item.id === selectedId;
          const link: ClientStripLinkProps = {
            className: 'ui-client-strip__item',
            'aria-current': selected ? 'page' : undefined,
            // The visible name leads, so the accessible name still contains it (checklist item 43).
            'aria-label': reasons === '' ? undefined : `${item.name}, ${reasons}`,
            children: <>
              <Avatar name={item.name} photoUrl={item.photoUrl} size="md" attention={reasons === '' ? undefined : reasons} />
              <span className="ui-client-strip__name">{selected ? <Realce>{item.name}</Realce> : item.name}</span>
            </>
          };
          return <li key={item.id}>{renderLink === undefined ? <a href={item.href} {...link} /> : renderLink(item, link)}</li>;
        })}
      </ul>
    </nav>
  );
}
