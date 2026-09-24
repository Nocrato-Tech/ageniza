# @ageniza/web

The product SPA is a React/Vite application with deliberate public and protected route boundaries. It currently provides infrastructure only: no sign-in, signup, social-login, or account-recovery screens are present.

## Browser configuration

The app loads configuration exclusively from `@ageniza/config/browser`. Set only the public Vite variables below; do not put server credentials in any `VITE_` variable.

```text
VITE_API_BASE_URL=http://127.0.0.1:3001
```

**The page never holds a credential.** The API authenticates with an httpOnly cookie (Better Auth, [ADR 0011](../../docs/adr/0011-self-hosted-postgres-and-better-auth.md)), so there is no token in JavaScript to steal, refresh, or leak: `GET /auth/session` answering *is* the proof of a session, and the session store in `auth.tsx` reads nothing else. `HttpClient` strips any `Authorization` header a caller tries to attach, validates every response against its contract, attaches a request correlation ID, sends credentials, and handles cancellation and timeouts.

Run a local production build with loopback values:

```powershell
$env:VITE_API_BASE_URL='http://127.0.0.1:3001'; pnpm --filter @ageniza/web build
```
