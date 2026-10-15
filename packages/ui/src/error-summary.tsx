import { useEffect, useRef, useState, type ReactElement, type RefObject } from 'react';
import { CircleAlert } from 'lucide-react';

import { IconSlot } from './icon.js';

const INVALID = '[aria-invalid="true"]';

/** The controls a form marks invalid, in the order of the form. */
export const invalidControls = (form: ParentNode | null): HTMLElement[] =>
  form === null ? [] : Array.from(form.querySelectorAll<HTMLElement>(INVALID));

/** Puts the focus on the first invalid control of the form; the field says what is wrong through `aria-describedby`. */
export const focusFirstInvalid = (form: ParentNode | null): boolean => {
  const first = invalidControls(form)[0];
  first?.focus();
  return first !== undefined;
};

const labelOf = (control: HTMLElement): string => {
  const labelled = control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement
    ? control.labels?.[0]?.textContent?.trim()
    : undefined;
  return labelled || control.getAttribute('aria-label') || control.id;
};

/**
 * What a refused form says as a whole: one alert, above the fields, when more than one is wrong. A single invalid field
 * needs no summary, the focus already took the person to it; one alert per field would be read N times over the focus announcement.
 */
export function ErrorSummary({ labels }: { labels: readonly string[] }) {
  if (labels.length < 2) return null;
  return (
    <p className="ui-error-summary" role="alert">
      <IconSlot><CircleAlert /></IconSlot>
      <span>Corrija {labels.length} campos: {labels.join(', ')}.</span>
    </p>
  );
}

/**
 * The report of a refused form. Put `formRef` on the form and render `summary` at the top of it. A refused submit (the
 * form's `submit` event, or `attempted()` for a button that validates on its own) arms it, and the first commit that has an
 * invalid control, now or when the server answers, moves the focus to it. Typing disarms it, so a field that turns
 * invalid under the person's hands (a counter over its limit) never takes the focus away.
 */
export function useFormErrors<T extends HTMLElement = HTMLFormElement>(): {
  formRef: RefObject<T | null>;
  attempted: () => void;
  summary: ReactElement;
} {
  const formRef = useRef<T>(null);
  const armed = useRef(false);
  const bound = useRef<T | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [labels, setLabels] = useState<readonly string[]>([]);

  const attempted = (): void => {
    armed.current = true;
    setAttempt((count) => count + 1);
  };
  const arm = useRef(attempted);
  arm.current = attempted;
  const onSubmit = useRef(() => { arm.current(); });
  const onInput = useRef(() => { armed.current = false; });

  const unbind = (): void => {
    bound.current?.removeEventListener('submit', onSubmit.current);
    bound.current?.removeEventListener('input', onInput.current);
    bound.current = null;
  };
  useEffect(() => unbind, []);

  // After every commit: the form may have mounted since, the first refusal that shows takes the focus, and the summary follows what is still invalid.
  useEffect(() => {
    const form = formRef.current;
    if (bound.current !== form) {
      unbind();
      form?.addEventListener('submit', onSubmit.current);
      form?.addEventListener('input', onInput.current);
      bound.current = form;
    }
    const controls = invalidControls(form);
    if (armed.current && controls.length > 0) {
      armed.current = false;
      controls[0]!.focus();
    }
    const next = attempt === 0 ? [] : controls.map(labelOf);
    setLabels((current) => (current.length === next.length && current.every((label, index) => label === next[index]) ? current : next));
  });

  return { formRef, attempted, summary: <ErrorSummary labels={labels} /> };
}
