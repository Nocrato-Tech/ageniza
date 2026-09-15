# @ageniza/web

The product SPA is a React/Vite application with deliberate public and protected route boundaries. It currently provides infrastructure only: no sign-in, signup, social-login, or account-recovery screens are present.

## Browser configuration

The app loads configuration exclusively from `@ageniza/config/browser`. Set only the public Vite variables below; do not put server credentials in any `VITE_` variable.

```text
VITE_API_BASE_URL=http://127.0.0.1:3001
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=local-anon-key
```

The Supabase browser client persists its public-session state locally and exposes a React session store. API calls go through the typed `HttpClient`, which validates contracts, attaches a request correlation ID, includes credentials intentionally, and has cancellation and timeout handling.

Run a local production build with loopback values:

```powershell
$env:VITE_API_BASE_URL='http://127.0.0.1:3001'; $env:VITE_SUPABASE_URL='http://127.0.0.1:54321'; $env:VITE_SUPABASE_ANON_KEY='local-anon-key'; pnpm --filter @ageniza/web build
```
