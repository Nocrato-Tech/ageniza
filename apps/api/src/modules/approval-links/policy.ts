/** A fixed-window rate-limit policy, same shape as `../media/policy.ts`. */
export interface ApprovalRateLimitWindow {
  readonly max: number;
  readonly windowMs: number;
}

/** The cookie of the approval session. It is not an account session: it reaches only the routes of the link. */
export const APPROVAL_COOKIE_NAME = 'ageniza_approval';

/** The prefix the routes are mounted under. The cookie is restricted to it. */
export const APPROVAL_ROUTE_PREFIX = '/portal-approval';

/**
 * The cookie is sent back only to the path the BROWSER sees, which is the path of the public address of the API
 * (`API_PUBLIC_URL`, the `VITE_API_BASE_URL` of the web build): behind the web server the API answers under `/api` (ADR 0012,
 * `apps/web/nginx.conf` strips it), and a cookie restricted to `/portal-approval` would never come back. `Secure` follows the
 * scheme of that same address.
 */
export const approvalCookieOptions = (apiPublicUrl: string): { readonly path: string; readonly secure: boolean } => {
  const base = new URL(apiPublicUrl);
  return { path: `${base.pathname.replace(/\/+$/, '')}${APPROVAL_ROUTE_PREFIX}`, secure: base.protocol === 'https:' };
};

const FIFTEEN_MINUTES_MS = 15 * 60 * 1_000;
const FIVE_MINUTES_MS = 5 * 60 * 1_000;

/**
 * Per IP and per token (the hash of the token or of the session, never the value). The exchange is the door anyone can knock on, so it
 * is the narrowest; the decisions come next; the reads, which the page makes a few of per visit, are the widest.
 */
export const APPROVAL_RATE_LIMITS = {
  exchangePerIp: { max: 30, windowMs: FIFTEEN_MINUTES_MS },
  exchangePerToken: { max: 10, windowMs: FIFTEEN_MINUTES_MS },
  decidePerIp: { max: 60, windowMs: FIFTEEN_MINUTES_MS },
  decidePerSession: { max: 30, windowMs: FIFTEEN_MINUTES_MS },
  readPerIp: { max: 300, windowMs: FIVE_MINUTES_MS },
  readPerSession: { max: 120, windowMs: FIVE_MINUTES_MS }
} as const satisfies Readonly<Record<string, ApprovalRateLimitWindow>>;

/** The preview media is signed for minutes, whatever the deployment allows the portal: the link lasts seven days, the file does not. */
export const APPROVAL_MEDIA_URL_MAX_SECONDS = 300;
