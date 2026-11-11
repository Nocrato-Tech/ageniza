import { forwardRef, useId, type InputHTMLAttributes } from 'react';

export type ChoiceRadioProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'title' | 'children'> & {
  /** What the choice does, in the imperative or as a result ("Aprovar como está"). It names the radio. */
  title: string;
  /** What follows from it; it describes the radio. */
  description?: string;
};

/**
 * One option of a choice that is made and then confirmed (approve or ask for an adjustment): a native radio in a card, which tints
 * and rings when chosen. Put the cards of one question in a `fieldset` with a `legend`; the arrow keys then move between them as the
 * browser does for any radio group. `ChoiceCard` is the other one: it acts at once, with no confirming step.
 */
export const ChoiceRadio = forwardRef<HTMLInputElement, ChoiceRadioProps>(function ChoiceRadio({ title, description, className, ...props }, ref) {
  const base = useId();
  const titleId = `${base}-title`;
  const descriptionId = `${base}-description`;
  return (
    <label className={['ui-choice-radio', className].filter(Boolean).join(' ')}>
      <input {...props} ref={ref} type="radio" aria-labelledby={titleId} aria-describedby={description === undefined ? undefined : descriptionId} />
      <span className="ui-choice-radio__text">
        <span id={titleId} className="ui-choice-radio__title">{title}</span>
        {description !== undefined && <span id={descriptionId} className="ui-choice-radio__description">{description}</span>}
      </span>
    </label>
  );
});
