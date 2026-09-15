# Forward-only migration runner. Built by the production workflow and run on the VPS by
# ageniza-deploy with MIGRATION_DATABASE_URL from a host-only env file (never from GitHub).
FROM node:22-bookworm-slim
ARG APP_VERSION=unknown
LABEL org.opencontainers.image.revision=$APP_VERSION
ENV APP_VERSION=$APP_VERSION
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/supabase-cli
RUN npm install --no-save --no-audit --no-fund supabase@2.117.0 \
  && ln -s /opt/supabase-cli/node_modules/.bin/supabase /usr/local/bin/supabase \
  && supabase --version
WORKDIR /workspace
COPY --chown=node:node supabase/config.toml supabase/config.toml
COPY --chown=node:node supabase/migrations supabase/migrations
USER node
ENTRYPOINT ["sh", "-c", "exec supabase db push --db-url \"$MIGRATION_DATABASE_URL\" --include-all --yes"]
