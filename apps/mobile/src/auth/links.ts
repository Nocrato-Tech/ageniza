export type AccountLink = { kind: 'verify' | 'reset' | 'invitation' | 'emailChange'; token: string };

export function parseAccountLink(input: string, trustedWebUrl: string): AccountLink | null {
  try {
    const url = new URL(input.trim());
    const native = url.protocol === 'ageniza:';
    if (!native && (url.protocol !== 'https:' || url.origin !== new URL(trustedWebUrl).origin)) return null;
    if (url.username || url.password || url.hash || url.searchParams.has('cookie')) return null;
    const path = native ? `/${url.hostname}${url.pathname}` : url.pathname;
    const invitation = /^\/convite\/([A-Za-z0-9_-]{1,2048})\/?$/.exec(path);
    if (invitation) return { kind: 'invitation', token: invitation[1] };
    const kind = path === '/email/verificar' ? 'verify' : path === '/senha/redefinir' ? 'reset' : path === '/email/confirmar' ? 'emailChange' : null;
    const tokens = url.searchParams.getAll('token');
    if (!kind || tokens.length !== 1 || !tokens[0] || tokens[0].length > 2048) return null;
    return { kind, token: tokens[0] };
  } catch { return null; }
}
