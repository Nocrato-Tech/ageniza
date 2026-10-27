# @ageniza/web

The product SPA is a React/Vite application with deliberate public and protected route boundaries. The sign-in, sign-up and account-recovery screens are in place. "Entrar com o Google" is drawn on `/entrar`, `/criar-conta` and the invitation screen only while `GET /auth/providers` answers `google: true`; any other answer, or none, leaves it out (specs/auth.md, section 13).

## Browser configuration

The app loads configuration exclusively from `@ageniza/config/browser`. Set only the public Vite variables below; do not put server credentials in any `VITE_` variable.

```text
VITE_API_BASE_URL=http://127.0.0.1:3001
```

**The page never holds a credential.** The API authenticates with an httpOnly cookie (Better Auth, [ADR 0011](../../docs/adr/0011-self-hosted-postgres-and-better-auth.md)), so there is no token in JavaScript to steal, refresh, or leak: `GET /auth/session` answering *is* the proof of a session, and the session store in `auth.tsx` reads nothing else. `HttpClient` strips any `Authorization` header a caller tries to attach, validates every response against its contract, attaches a request correlation ID, sends credentials, and handles cancellation and timeouts.

**The approval link carries a credential in the address.** `/aprovar#<token>` is a public page outside the signed-in shell (`approval-link.tsx`). It reads the fragment once, erases it with `history.replaceState` before any request leaves, and sends the token only in the body of `POST /portal-approval/session`; the page keeps no copy after the answer, and the session cookie (`httpOnly`, never visible to the page) holds the access from then on. The token is never put in a query string, and the page sets `<meta name="referrer" content="no-referrer">` itself while it is open (the static `index.html` carries the same value). Opening the link decides nothing: Aprovar and Pedir ajuste are clicks, and a button exists only when the lot says `canDecide`.

Run a local production build with loopback values:

```powershell
$env:VITE_API_BASE_URL='http://127.0.0.1:3001'; pnpm --filter @ageniza/web build
```
