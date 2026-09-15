# Forward-only migration runner. Built by the production workflow and run on the VPS by
# ageniza-deploy with MIGRATION_DATABASE_URL from a host-only env file (never from GitHub).
FROM node:22-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/database/package.json packages/database/package.json
RUN pnpm install --frozen-lockfile
COPY packages/database packages/database
RUN pnpm --filter @ageniza/database --prod deploy /runtime

FROM node:22-bookworm-slim
ARG APP_VERSION=unknown
LABEL org.opencontainers.image.revision=$APP_VERSION
ENV NODE_ENV=production
ENV APP_VERSION=$APP_VERSION
WORKDIR /app
COPY --from=build /runtime ./
USER node
ENTRYPOINT ["node", "bin/migrate.mjs"]
