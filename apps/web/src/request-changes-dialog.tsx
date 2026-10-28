import { useState, type FormEvent } from 'react';

import { CommentBodySchema } from '@ageniza/contracts';
import { Button, Field, FieldMessage, Modal, Textarea, useFormErrors } from '@ageniza/ui';

export const COMMENT_MESSAGES = {
  empty: 'Escreva o que precisa mudar.',
  tooLong: 'O pedido pode ter no máximo 5.000 bytes.',
  invalidCharacters: 'O texto contém caracteres que não são aceitos.'
} as const;

/** The rule of the API, not a copy of it: the screen asks the contract's own schema and only words the answer. */
export const commentProblem = (comment: string): string | undefined => {
  const parsed = CommentBodySchema.safeParse(comment);
  if (parsed.success) return undefined;
  const message = parsed.error.issues[0]?.message;
  if (message === 'must not be empty') return COMMENT_MESSAGES.empty;
  if (message === 'must be at most 5000 bytes') return COMMENT_MESSAGES.tooLong;
  return COMMENT_MESSAGES.invalidCharacters;
};

/** What went wrong with the request: `field` when it is the text itself (the server refused its characters), otherwise the request as a whole. */
export interface RequestError {
  readonly message: string;
  readonly field: boolean;
}

/** The comment of "Pedir ajuste", required: the portal and the approval link ask for it the same way. */
export function RequestChangesDialog({ draft, onDraft, pending, error, hint, onSubmit, onClose }: {
  draft: string;
  onDraft: (value: string) => void;
  pending: boolean;
  error: RequestError | undefined;
  hint: string;
  onSubmit: (comment: string) => void;
  onClose: () => void;
}) {
  const [problem, setProblem] = useState<string | undefined>();
  const { formRef, summary } = useFormErrors();
  const fieldProblem = problem ?? (error?.field === true ? error.message : undefined);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const found = commentProblem(draft);
    if (found !== undefined) { setProblem(found); return; }
    onSubmit(draft.trim());
  };

  return <Modal title="Pedir ajuste" closeLabel="Fechar pedido de ajuste" onClose={onClose}>
    <form ref={formRef} className="portal-post__request" onSubmit={submit} noValidate>
      {summary}
      <Field label="O que precisa mudar?" hint={hint} error={fieldProblem}>
        {(control) => <Textarea
          {...control}
          value={draft}
          rows={5}
          placeholder="Escreva aqui"
          readOnly={pending}
          onChange={(event) => { onDraft(event.target.value); setProblem(undefined); }}
        />}
      </Field>
      {error?.field === false && <FieldMessage role="alert">{error.message}</FieldMessage>}
      <div className="portal-post__actions">
        <Button type="submit" loading={pending}>Enviar pedido</Button>
      </div>
    </form>
  </Modal>;
}
