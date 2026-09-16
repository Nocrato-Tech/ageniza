# ADR 0012: Cloudflare Tunnel as the public edge, replacing Caddy

- Status: Accepted
- Date: 2026-09-16
- Deciders: Ageniza maintainers
- Supersedes: the Caddy edge chosen in [ADR 0010](0010-vps-edge-and-production-deployment.md) and its Let's Encrypt amendment

## Context

ADR 0010 chose Caddy on the VPS: it publishes 80/443, obtains certificates, and reverse-proxies to the web and API containers. Cloudflare sits in front with Full (strict).

Two things changed since that decision:

- Cloudflare is already a hard dependency of the architecture (DNS, proxy, and R2 for files), so an edge that relies on it costs no new vendor.
- Media is going **direct from the browser to R2** with signed multipart uploads (issue #21), because the product manages social content including long video and Reels. Only light API traffic reaches the VPS, so Cloudflare's 100 MB proxied-request limit does not constrain the design.

With Caddy the origin also keeps a real attack surface: anyone who learns the VPS IP can reach ports 80/443 directly unless Authenticated Origin Pulls is configured as extra hardening, and the certificate has to be issued and renewed.

## Decision

Use **Cloudflare Tunnel** (`cloudflared`) as the only public entry point, and remove Caddy.

`cloudflared` runs as a container that opens an **outbound** connection to Cloudflare. The VPS publishes **no application ports at all**; the firewall keeps only SSH.

```text
Internet
  -> Cloudflare (DNS, proxy, TLS, WAF)
  -> outbound tunnel
  -> cloudflared (proxy network, no ports)
  -> web:8080  (serves the SPA and proxies /api)
       -> api:3001 (private network)
            -> postgres (private network)
  worker (private network only)
  browser -> R2 directly for media (never through the VPS)
```

Three constraints make this concrete:

- **Routing stays in Git.** The tunnel is locally managed: `infra/vps/cloudflared/config.yml` holds the ingress rules and is installed by the bundle installer; the tunnel id is a deploy configuration value and the credentials file is a root-owned secret on the VPS. Ingress is deliberately not configured in the Cloudflare dashboard, because dashboard state is not versioned and no runbook restores it.
- **One public hostname, same origin.** `cloudflared` forwards everything to the web container, whose nginx serves the SPA and proxies `/api/` to the API, stripping the prefix. Browser and API share an origin, so there is no CORS preflight and no cross-subdomain cookie problem for the authentication work (issue #20). The real client IP arrives as `CF-Connecting-IP` and nginx forwards it as `X-Forwarded-For`.
- **SSH stays open.** The deploy path is SSH with a forced command (ADR 0010 amendment). Closing SSH entirely would require routing it through Cloudflare Access and reworking the deploy workflow; that is not part of this decision.

## Consequences

- No certificate to issue, renew, or monitor; no `80/443` exposure; the origin IP is not reachable for application traffic. The Cloudflare IP allowlist and the `refresh-cloudflare-ips` job disappear.
- **Cloudflare becomes a hard single dependency for availability.** With Caddy, a Cloudflare incident could be worked around by switching DNS to grey cloud; with a tunnel there is no origin to point at. Recovering from a prolonged Cloudflare outage means reopening ports and installing a proxy and certificate, which is a deliberate emergency procedure, not a routine one.
- The `cloudflared` image has no shell, so the container has no healthcheck; liveness is the tunnel status in Cloudflare plus `restart: unless-stopped`. This is an explicit exception to the VPS baseline rule that every long-running container has a healthcheck.
- The web container is now in the path of API traffic. If it is unhealthy, the API is unreachable even when healthy. Accepted for the MVP: both are replaced together by the same release.
- A second public hostname later (for example an internal tool) is an added ingress rule with a `hostname` match plus a DNS route, still in Git.

## Alternatives considered

### Keep Caddy with Authenticated Origin Pulls

Works, and keeps a Cloudflare-independent origin. Rejected because it keeps open ports, certificate lifecycle, and the Cloudflare range list for real client IPs, in exchange for a fallback that the architecture does not otherwise rely on.

### Cloudflare Tunnel with dashboard-managed ingress

The simplest to set up: a token in the environment and routes configured in the dashboard. Rejected because routing would become click-ops outside Git, contradicting the reproducibility this project's deploy is built on.

### A dedicated `api.<domain>` hostname

Cleaner separation, but it makes the browser cross-origin: CORS preflights on every call and cookie-domain handling for sessions. Same-origin through the web container avoids both at no real cost.

## References

- [Cloudflare Tunnel: locally-managed tunnels and `config.yml` ingress rules](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/configuration-file/)
- [Cloudflare: request limits on the proxy](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare R2: presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
