import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

import { Button, FieldMessage, LiveStatus } from '@ageniza/ui';

const COPY_FAILED = 'Não foi possível copiar o link. Ele também está no e-mail enviado.';

/**
 * "Copiar link" for an invitation just sent (decision 2026-10-26, issue #715). The link lives only in
 * the caller's component state: it is never rendered as text, never put in a URL, and closing the
 * screen that holds it drops it for good; a resend is the way to get another one.
 */
export function CopyInvitationLinkButton({ url }: { url: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url);
      setState('copied');
    } catch {
      setState('failed');
    }
  };

  return <div className="form-field">
    <Button variant="secondary" leadingIcon={state === 'copied' ? <Check /> : <Copy />} onClick={() => { void copy(); }}>
      {state === 'copied' ? 'Link copiado' : 'Copiar link'}
    </Button>
    {state === 'copied' && <LiveStatus className="visually-hidden">Link copiado.</LiveStatus>}
    {state === 'failed' && <FieldMessage role="alert">{COPY_FAILED}</FieldMessage>}
  </div>;
}
