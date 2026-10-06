FROM node:22-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable
ARG VITE_API_BASE_URL
ARG VITE_SENTRY_DSN
ARG VITE_APP_VERSION=unknown
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL VITE_SENTRY_DSN=$VITE_SENTRY_DSN VITE_APP_VERSION=$VITE_APP_VERSION
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY .pnpmfile.cjs ./
COPY apps/web/package.json apps/web/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN pnpm install --frozen-lockfile
COPY apps apps
COPY packages packages
# version.txt lets the production smoke test prove which release the public site serves.
RUN pnpm --filter @ageniza/web... build && printf '%s\n' "$VITE_APP_VERSION" > apps/web/dist/version.txt
FROM nginxinc/nginx-unprivileged:1.27-alpine
ARG APP_VERSION=unknown
LABEL org.opencontainers.image.revision=$APP_VERSION
ENV APP_VERSION=$APP_VERSION
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
