import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

import { Button, FieldMessage, LiveStatus } from '@ageniza/ui';

const COPY_FAILED = 'Não foi possível copiar o link. Ele também está no e-mail enviado.';

type CopyState = 'idle' | 'copied' | 'failed';

/** Writes to the clipboard and remembers how it went; a refused clipboard (permission, insecure context) is a state, not an exception. */
const useCopy = (text: string): { state: CopyState; copy: () => void } => {
  const [state, setState] = useState<CopyState>('idle');
  const copy = (): void => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(text);
        setState('copied');
      } catch {
        setState('failed');
      }
    })();
  };
  return { state, copy };
};

/**
 * "Copiar link" for an invitation just sent (decision 2026-10-26, issue #715). The link lives only in
 * the caller's component state: it is never rendered as text, never put in a URL, and closing the
 * screen that holds it drops it for good; a resend is the way to get another one.
 */
export function CopyInvitationLinkButton({ url }: { url: string }) {
  const { state, copy } = useCopy(url);

  return <div className="form-field">
    <Button variant="secondary" leadingIcon={state === 'copied' ? <Check /> : <Copy />} onClick={copy}>
      {state === 'copied' ? 'Link copiado' : 'Copiar link'}
    </Button>
    {state === 'copied' && <LiveStatus className="visually-hidden">Link copiado.</LiveStatus>}
    {state === 'failed' && <FieldMessage role="alert">{COPY_FAILED}</FieldMessage>}
  </div>;
}

/**
 * "Copiar link" of the portal's entry address with its ready message (decision 2026-11-10). The address carries no token and gives no access
 * alone, so, unlike the invitation link, it may be shown as text when the clipboard refuses and the person has to copy it by hand.
 */
export function CopyPortalAccessButton({ message, address, subject }: { message: string; address: string; subject: string }) {
  const { state, copy } = useCopy(message);
  const copied = state === 'copied';

  return <div className="portal-access__copy">
    <Button
      size="sm"
      variant="secondary"
      leadingIcon={copied ? <Check /> : <Copy />}
      aria-label={`${copied ? 'Link copiado' : 'Copiar link'} para ${subject}`}
      onClick={copy}
    >
      {copied ? 'Link copiado' : 'Copiar link'}
    </Button>
    {copied && <LiveStatus className="visually-hidden">{`Link copiado para ${subject}.`}</LiveStatus>}
    {state === 'failed' && <FieldMessage role="alert">{`Não foi possível copiar. O endereço de entrada é ${address}`}</FieldMessage>}
  </div>;
}
