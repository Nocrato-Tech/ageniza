import type { ReactNode } from 'react';

/**
 * The shape of every full-page status of the product (not found, session ended, unexpected error):
 * the serious mascot, what happened, and the one way out. Local to the web app until `packages/ui`
 * has a status component to replace it. The mascot is decorative (`alt=""`): the title says it all,
 * and there is exactly one per screen (docs/brand.md).
 */
export function StatusPanel({ as: Landmark = 'main', titleId, title, action, children }: {
  as?: 'main' | 'section';
  titleId: string;
  title: string;
  action: ReactNode;
  children: ReactNode;
}) {
  return <Landmark className="page-status" aria-labelledby={titleId}>
    <div className="status-panel">
      <img
        className="status-panel__mascot"
        src="/brand/mascote-serio.webp"
        srcSet="/brand/mascote-serio.webp 1x, /brand/mascote-serio@2x.webp 2x"
        width={191}
        height={240}
        alt=""
      />
      <h1 id={titleId}>{title}</h1>
      <p>{children}</p>
      <div className="status-panel__action">{action}</div>
    </div>
  </Landmark>;
}

/** An anchor dressed as the primary `Button`: the way out of a status page is a navigation, not a click handler. */
export const LINK_BUTTON_CLASS = 'ui-button ui-button--primary ui-button--lg';
