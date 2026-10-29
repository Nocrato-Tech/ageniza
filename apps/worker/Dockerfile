FROM node:22-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY .pnpmfile.cjs ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/email/package.json packages/email/package.json
COPY packages/payments/package.json packages/payments/package.json
RUN pnpm install --frozen-lockfile
COPY apps apps
COPY packages packages
RUN pnpm --filter @ageniza/worker... build && pnpm --filter @ageniza/worker --prod deploy /runtime
# The simulated payment provider (issue #772) is code that approves any card. The production release builds with
# PAYMENTS_SIMULATED=exclude, which removes it here, in the build stage, so the final stage copies a tree that never had it and no
# layer of the shipped image holds it; the worker also refuses to start with it in production. The default keeps it, because the dev
# and local environments run this same image with PAYMENTS_PROVIDER=simulado.
ARG PAYMENTS_SIMULATED=include
RUN if [ "$PAYMENTS_SIMULATED" = "exclude" ]; then \
      rm -rf /runtime/node_modules/@ageniza/payments/dist/simulated && test ! -e /runtime/node_modules/@ageniza/payments/dist/simulated; \
    elif [ "$PAYMENTS_SIMULATED" != "include" ]; then \
      echo "PAYMENTS_SIMULATED must be include or exclude" >&2 && exit 1; \
    fi
FROM node:22-bookworm-slim
ARG APP_VERSION=unknown
ENV NODE_ENV=production
ENV APP_VERSION=$APP_VERSION
# Video processing (issue #24): ffmpeg/ffprobe generate the thumbnail and 720p preview for a
# confirmed video. Debian's bookworm package is pinned by the base image's own apt snapshot, and
# the apt list cache is removed so it never lingers in the image layer.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /runtime ./
USER node
EXPOSE 3002
CMD ["node", "dist/index.js"]
