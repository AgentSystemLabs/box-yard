# Box Yard: API + web app + the Coordinator's agent CLIs (Claude Code, and Codex: docs/codex.md), in one image.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
# Claude Code's floor is MIN_CLAUDE_CLI (shared/claudeCli.ts), the oldest that knows every model Box Yard offers:
# raising it rebuilds this layer, which would otherwise keep the version it was first built with.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl tini \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g "@anthropic-ai/claude-code@>=2.1.321" @openai/codex --no-audit --no-fund
COPY --from=build /app /app
# A fresh install here runs agents in Upstash boxes: "this computer" would be the server's own container.
ENV NODE_ENV=production \
    BOXYARD_DATA_DIR=/data \
    PORT=3000 \
    HOST=0.0.0.0 \
    DISABLE_AUTOUPDATER=1 \
    BOXYARD_DEFAULT_RUNNER=box
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fs http://localhost:3000/healthz || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server/server/index.js"]
