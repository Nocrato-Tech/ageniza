import type { OlHTMLAttributes, ReactNode } from 'react';

/** Done is a filled dot with a check; current is a ring that pulses; upcoming is an empty dot. */
export type MilestoneStatus = 'done' | 'current' | 'upcoming';

export type MilestoneStep = {
  /** Stable, so a step that changes status keeps its element and the dot fills, the check draws and the line runs. */
  id: string;
  title: ReactNode;
  status: MilestoneStatus;
  /** When and by whom, shown only once the step is done. */
  when?: ReactNode;
  /** What the step asks (current) or announces (upcoming); a done step shows `when` instead. */
  description?: ReactNode;
  /** The way forward of the current step, usually a `Button`; shown only on it. */
  action?: ReactNode;
};

export type MilestoneTrailProps = Omit<OlHTMLAttributes<HTMLOListElement>, 'children'> & {
  steps: readonly MilestoneStep[];
  size?: 'md' | 'sm';
  /** The words said to assistive technology before each title, since the dot is only a picture. */
  statusLabels?: Readonly<Record<MilestoneStatus, string>>;
};

const STATUS_LABELS: Readonly<Record<MilestoneStatus, string>> = { done: 'Feito', current: 'Passo atual', upcoming: 'Próximo passo' };

/**
 * The trail every milestone of the app uses: dots tied by a line. The status is the only input, so moving a step from
 * `current` to `done` (and the next one to `current`) is what plays the fill, the check and the line; with reduced
 * motion the same end state appears at once. The reward (confetti) is not drawn here: see `MilestoneCelebration`.
 */
export function MilestoneTrail({ steps, size = 'md', statusLabels = STATUS_LABELS, className, ...props }: MilestoneTrailProps) {
  return (
    <ol className={['ui-trail', size === 'sm' && 'ui-trail--sm', className].filter(Boolean).join(' ')} {...props}>
      {steps.map((step) => (
        <li
          key={step.id}
          className={`ui-trail__item ui-trail__item--${step.status}`}
          aria-current={step.status === 'current' ? 'step' : undefined}
          data-status={step.status}
        >
          <span className="ui-trail__rail" aria-hidden="true">
            <span className="ui-trail__node">
              <svg className="ui-trail__check" viewBox="0 0 24 24" focusable="false">
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
            </span>
            <span className="ui-trail__line" />
          </span>
          <div className="ui-trail__body">
            <p className="ui-trail__title">
              <span className="ui-trail__status">{statusLabels[step.status]}: </span>
              {step.title}
            </p>
            {step.status === 'done' && step.when !== undefined && <p className="ui-trail__when">{step.when}</p>}
            {step.status !== 'done' && step.description !== undefined && <p className="ui-trail__desc">{step.description}</p>}
            {step.status === 'current' && step.action !== undefined && <div className="ui-trail__act">{step.action}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}
