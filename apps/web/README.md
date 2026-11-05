# @ageniza/web

The product SPA is a React/Vite application with deliberate public and protected route boundaries. The sign-in, sign-up and account-recovery screens are in place. "Entrar com o Google" is drawn on `/entrar`, `/criar-conta` and the invitation screen only while `GET /auth/providers` answers `google: true`; any other answer, or none, leaves it out (specs/auth.md, section 13).

## Browser configuration

The Nginx API proxy keeps a 1 MiB general request-body ceiling. Only `/api/me/photo` and `/api/agencies/:agencyId/clients/:clientId/photo` allow 14 MiB, enough to transport a 10 MiB identity image in base64 JSON; Fastify still enforces its configured image limit, session and permission checks. Media uploads continue going directly to their presigned storage URL. The proxy admits at most 16 active API requests per client IP, with an additional ceiling of 2 identity-photo requests per client IP, returning 429 above either ceiling; one client filling its slots does not take them from others. These bounds reduce concurrent parsing exposure; they are not a guarantee against all memory exhaustion. Static health and mobile assets do not consume these API slots.

`nginx-api-proxy.inc` contains the forwarding policy shared by both locations, including the empty upstream `Connection` header. The `Mobile review` workflow runs `scripts/ci/verify-nginx-api.mjs` against the actual dev/production web images and a disposable test upstream, without a database or customer data. It checks allowed and oversized photo bodies, unchanged generic limits, forwarding, per-client concurrency (one client saturated, another still served), the preserved `Host` and static health. The deliberate mutations must fail. This does not replace the authenticated identity-storage integration tests or independent security review. Nginx references: [body limit](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size), [shared connection limits](https://nginx.org/en/docs/http/ngx_http_limit_conn_module.html), [upstream headers](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header).

The app loads configuration exclusively from `@ageniza/config/browser`. Set only the public Vite variables below; do not put server credentials in any `VITE_` variable.

```text
VITE_API_BASE_URL=http://127.0.0.1:3001
```

**The page never holds a credential.** The API authenticates with an httpOnly cookie (Better Auth, [ADR 0011](../../docs/adr/0011-self-hosted-postgres-and-better-auth.md)), so there is no token in JavaScript to steal, refresh, or leak: `GET /auth/session` answering *is* the proof of a session, and the session store in `auth.tsx` reads nothing else. `HttpClient` strips any `Authorization` header a caller tries to attach, validates every response against its contract, attaches a request correlation ID, sends credentials, and handles cancellation and timeouts.

**The approval link carries a credential in the address.** `/aprovar#<token>` is a public page outside the signed-in shell (`approval-link.tsx`). It reads the fragment, erases it with `history.replaceState` before any request leaves (also when the link is opened again on the tab that already has the page: only the fragment changes, so the page listens to `hashchange`, drops what the old link had in flight and opens the new one), and sends the token only in the body of `POST /portal-approval/session`; the page keeps no copy after the answer, and the session cookie (`httpOnly`, never visible to the page) holds the access from then on. The token is never put in a query string, and the page sets `<meta name="referrer" content="no-referrer">` itself while it is open (the static `index.html` carries the same value). Opening the link decides nothing: Aprovar and Pedir ajuste are clicks, and a button exists only when the lot says `canDecide`.

**`/mobile` is a development page.** It shows `docs/mobile/` (the guide for the team that builds the Expo app, with the flow diagrams) and a reference built from `docs/api/openapi.json` (routes by tag, search, an example `fetch` call per route). It needs no sign-in and sits outside the agency shell and the portal. The content is read from the repository when the page is built, so there is no copy to keep in sync; mermaid and the Markdown renderer are loaded only on this page. It exists only where `import.meta.env.DEV` is true (`pnpm dev`) or `VITE_DEV_DOCS=true` is set at build time, which only the dev image does (`.github/workflows/dev.yml` passes it as a build argument; `apps/web/Dockerfile` declares it). In the production build the condition is `false`, so the route, the Markdown, the API file, the styles and mermaid are not in the bundle; `src/mobile-docs/mobile-docs-build.test.ts` builds both ways and checks it. Address in dev: `https://dev.ageniza.com.br/mobile`.

Run a local production build with loopback values:

```powershell
$env:VITE_API_BASE_URL='http://127.0.0.1:3001'; pnpm --filter @ageniza/web build
```
