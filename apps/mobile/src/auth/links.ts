export type AccountLink = { kind: 'verify' | 'reset' | 'invitation' | 'emailChange' | 'approval'; token: string };

export function parseAccountLink(input: string, trustedWebUrl: string): AccountLink | null {
  try {
    const url = new URL(input.trim());
    const native = url.protocol === 'ageniza:';
    if (!native && (url.protocol !== 'https:' || url.origin !== new URL(trustedWebUrl).origin)) return null;
    if (url.username || url.password || url.searchParams.has('cookie')) return null;
    const path = native ? `/${url.hostname}${url.pathname}` : url.pathname;
    if (path === '/aprovar' && !url.search && /^#[A-Za-z0-9_-]{43}$/.test(url.hash)) return { kind: 'approval', token: url.hash.slice(1) };
    if (url.hash) return null;
    const invitation = /^\/convite\/([A-Za-z0-9_-]{1,2048})\/?$/.exec(path);
    if (invitation) return { kind: 'invitation', token: invitation[1] };
    const mobileVerification = !native && path === '/app-mobile/' && url.searchParams.getAll('action').length === 1 && url.searchParams.get('action') === 'verify';
    const kind = path === '/email/verificar' || mobileVerification ? 'verify' : path === '/senha/redefinir' ? 'reset' : path === '/email/confirmar' ? 'emailChange' : null;
    const tokens = url.searchParams.getAll('token');
    if (!kind || tokens.length !== 1 || !tokens[0] || tokens[0].length > 2048) return null;
    return { kind, token: tokens[0] };
  } catch { return null; }
}
