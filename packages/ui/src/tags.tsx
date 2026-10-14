import type { HTMLAttributes } from 'react';
import { Check, CheckCheck, Circle, Clock, Pencil } from 'lucide-react';

import { IconSlot } from './icon.js';

/** The formats that have colour tokens (`format/*`, docs/design-system.md section 6); the screen maps its own formats onto these. */
export type FormatTagFormat = 'carousel' | 'reels' | 'static';

export type FormatTagProps = HTMLAttributes<HTMLSpanElement> & {
  format: FormatTagFormat;
};

/**
 * The format of a content in a filled label ("Carrossel", "Reels", "Estático"). The words name the format; the fill only
 * tells the formats apart at a glance, so it is never the only signal. It is static: it has no hover, focus or loading.
 */
export function FormatTag({ format, className, children, ...props }: FormatTagProps) {
  return (
    <span className={['ui-format-tag', `ui-format-tag--${format}`, className].filter(Boolean).join(' ')} {...props}>
      {children}
    </span>
  );
}

/** What a content is going through. `late` is not here: it is `LateBadge`, the only state in a filled block. */
export type StatusTagStatus = 'ready' | 'waiting' | 'adjust' | 'published' | 'production';

/** One lucide shape per state, so two states are told apart by form and not by colour (docs/design-system.md section 6). */
const STATUS_ICONS: Readonly<Record<StatusTagStatus, typeof Check>> = {
  ready: Check,
  waiting: Clock,
  adjust: Pencil,
  published: CheckCheck,
  production: Circle
};

export type StatusTagProps = HTMLAttributes<HTMLSpanElement> & {
  status: StatusTagStatus;
};

/**
 * The state of a content: an outline, the state's icon and its label. The colour goes on the icon (non-text, 3:1) and the
 * label stays `text/secondary`, so the text pair never depends on the state. It is static, like `FormatTag`.
 */
export function StatusTag({ status, className, children, ...props }: StatusTagProps) {
  const Icon = STATUS_ICONS[status];
  return (
    <span className={['ui-status-tag', `ui-status-tag--${status}`, className].filter(Boolean).join(' ')} {...props}>
      <IconSlot><Icon /></IconSlot>
      {children}
    </span>
  );
}

/** "Atrasado": the one state in a solid block, because it must jump out of a card full of outlines. */
export function LateBadge({ className, children = 'Atrasado', ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={['ui-late-badge', className].filter(Boolean).join(' ')} {...props}>{children}</span>;
}
