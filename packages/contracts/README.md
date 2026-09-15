# @ageniza/contracts

`@ageniza/contracts` contains browser-safe public application-boundary schemas. Zod schemas are the runtime source of truth; TypeScript types are inferred from those schemas. It is intentionally limited to public HTTP request and response payloads, and has no dependency on `@ageniza/core`, `@ageniza/database`, Node built-ins, repositories, services, or domain logic.

## Structure and conventions

- Add a focused module in `src/` and re-export it from `src/index.ts`.
- Name Zod values with a `Schema` suffix (`CreateProjectRequestSchema`, `ProjectResponseSchema`) and export the matching inferred type without the suffix (`CreateProjectRequest`, `ProjectResponse`).
- Request schemas describe only client-controlled input. Response schemas describe only safe, public output. Use `.strict()` unless forward-compatible passthrough behavior is explicitly required at that boundary.
- Public collection requests use `PaginationInputSchema`; endpoints choose their own defaults and limits. Public page responses use `createPaginatedResponseSchema(itemSchema)` and `PaginationMetadataSchema`.
- Expected API failures use `ApiErrorResponseSchema`: `{ error: { code, message, details? }, meta?: { requestId? } }`. Never serialize stack traces, internal error names, database errors, credentials, or tenant internals into `details`.

## Promotion and evolution

Promote a schema here only when it crosses an application boundary and at least two consumers need the same stable interpretation (for example API plus web, another client, or an external integration). Keep one schema per current public representation; do not promote persistence rows, Knex results, aggregates, authorization state, or service inputs merely for convenience.

Additive optional fields are backwards compatible. Required fields, removals, renamed fields, changed meanings, and incompatible validation changes require a new versioned schema and endpoint/media-type versioning plan before adoption. Preserve the existing schema while clients migrate, test both versions, and remove it only after the documented compatibility window.

## Anti-patterns

Do not import server packages, environment/config loaders, database code, Node modules, or framework request/reply objects. Do not put authorization checks, data access, defaults tied to a product policy, serialization logic, API handlers, or domain entities in this package. Do not publish catch-all `any` payloads or reuse a database record as a public response just because the shapes currently match.
