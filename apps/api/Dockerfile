# The API runs TypeScript directly with tsx: there is no build step in
# apps/api (pnpm dev and pnpm test both run tsx against src/), so adding a
# compile here would create a second, untested way to start the server.
# Node 24 matches the engines field.
#
# Build from the repository root, because the lockfile and the workspace
# packages live there:
#
#   docker build -f apps/api/Dockerfile -t erp-api .

FROM node:24.15-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.34.4 --activate
WORKDIR /repo

# --- install and prune ------------------------------------------------
FROM base AS build
# Fetch into the store first so a code-only change reuses this layer.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline
# deploy resolves the workspace links into one self-contained directory.
RUN pnpm --filter @erp/api deploy --prod --legacy /app
# Every workspace package publishes TypeScript sources, so the runtime needs a
# TypeScript loader. tsx is a devDependency and --prod drops it, so pin the
# same version separately.
RUN npm install --prefix /runner tsx@4.23.13

# --- runtime ----------------------------------------------------------
FROM node:24.15-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=3001
# The proxy in front of this container cannot reach a loopback listener, so
# listen on every interface inside the container. Publish the port only to the
# private network the proxy uses (docs/auth/RELEASE.md, checklist item 16).
ENV HOST=0.0.0.0
WORKDIR /app
# node:alpine already ships the unprivileged "node" user.
COPY --from=build --chown=node:node /app /app
COPY --from=build --chown=node:node /runner/node_modules /app/.runner/node_modules
USER node
EXPOSE 3001
# The health route is registered in apps/api/src/app.ts.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["/app/.runner/node_modules/.bin/tsx", "src/server.ts"]
