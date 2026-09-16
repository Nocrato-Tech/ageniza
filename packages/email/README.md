# `@ageniza/email`

Server-only transactional email: invitation, email verification, and password reset (issue #19). One SMTP path is used everywhere, so there is no provider SDK to replace later: [Mailpit](https://mailpit.axllent.org/) locally, the approved provider in production.

```ts
const sender = createEmailSender({ smtpUrl: config.smtpUrl, from: config.emailFrom, logger });
const message = invitationEmail({ actionUrl, expiresInMinutes: 60, agencyName });
await sender.send({ ...message, to: recipient, template: 'invitation' });
```

## Rules

- **Never log a link, token, or full address.** `send` logs the template name, a masked recipient (`***@domain`), the message id, and the duration. The body is never logged.
- Action URLs must be HTTPS; `http://` is accepted only for loopback in local development.
- HTML is escaped, so an agency name or URL cannot inject markup.
- Wording is intentionally minimal. The approved invitation, activation, and reset copy comes from the authentication UX specification and lands with the Better Auth work (issue #20).
- Sending is direct and bounded by a timeout. Retry and queueing wait for the worker's durable transport; do not add speculative queue infrastructure here.

## Local development

`pnpm docker:up` starts Mailpit. Its web interface is on <http://127.0.0.1:8025> and the API and worker send through `smtp://mailpit:1025`. No message leaves the machine.

## Production

`SMTP_URL` and `EMAIL_FROM` live in `/etc/ageniza/runtime.env` on the VPS. The sending domain needs SPF, DKIM, and DMARC before real invitations go out; see the [production deploy runbook](../../docs/infra/production-deploy.md).
