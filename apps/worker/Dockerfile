FROM node:22-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/database/package.json packages/database/package.json
RUN pnpm install --frozen-lockfile
COPY apps apps
COPY packages packages
RUN pnpm --filter @ageniza/worker... build && pnpm --filter @ageniza/worker --prod deploy /runtime
FROM node:22-bookworm-slim
ARG APP_VERSION=unknown
ENV NODE_ENV=production
ENV APP_VERSION=$APP_VERSION
WORKDIR /app
COPY --from=build /runtime ./
USER node
EXPOSE 3002
CMD ["node", "dist/index.js"]
