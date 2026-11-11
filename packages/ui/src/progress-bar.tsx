import type { CSSProperties, HTMLAttributes } from 'react';

export type ProgressBarProps = Omit<HTMLAttributes<HTMLDivElement>, 'role' | 'children'> & {
  /** What is progressing ("Aprovação do mês"); a bar without a name says nothing. */
  label: string;
  value: number;
  /** The value that means done (default 100). */
  max?: number;
  tone?: 'indigo' | 'teal';
};

/** A thin bar for how far something went. The number belongs in the text beside it: the bar is only the picture of it. */
export function ProgressBar({ label, value, max = 100, tone = 'indigo', className, style, ...props }: ProgressBarProps) {
  const top = max > 0 ? max : 100;
  const clamped = Math.min(Math.max(Number.isFinite(value) ? value : 0, 0), top);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={top}
      aria-valuenow={clamped}
      className={['ui-progress-bar', tone === 'teal' && 'ui-progress-bar--teal', className].filter(Boolean).join(' ')}
      style={{ '--ui-progress': `${(clamped / top) * 100}%`, ...style } as CSSProperties}
      {...props}
    >
      <span className="ui-progress-bar__fill" />
    </div>
  );
}
