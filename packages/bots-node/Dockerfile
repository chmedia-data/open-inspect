# syntax=docker/dockerfile:1
#
# The bots as one container image: src/main.ts bundled with all three bot
# Workers. `BOT` (github, slack or linear) picks the one a container serves;
# run one container per bot, each with only that bot's configuration.
#
# Build from the repository root so the shared package and the bots are in
# the context:
#   docker build -f packages/bots-node/Dockerfile -t open-inspect-bots .

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/github-bot/package.json packages/github-bot/
COPY packages/slack-bot/package.json packages/slack-bot/
COPY packages/linear-bot/package.json packages/linear-bot/
COPY packages/bots-node/package.json packages/bots-node/
# --ignore-scripts: the root package's prepare script installs git hooks.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts \
      --workspace=@open-inspect/shared \
      --workspace=@open-inspect/github-bot \
      --workspace=@open-inspect/slack-bot \
      --workspace=@open-inspect/linear-bot \
      --workspace=@open-inspect/bots-node
COPY packages/shared/ packages/shared/
COPY packages/github-bot/ packages/github-bot/
COPY packages/slack-bot/ packages/slack-bot/
COPY packages/linear-bot/ packages/linear-bot/
COPY packages/bots-node/ packages/bots-node/
RUN npm run build -w @open-inspect/shared \
    && npm run build -w @open-inspect/bots-node

FROM node:24-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    INTERNAL_PORT=8081 \
    DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/packages/bots-node/dist/main.js /app/main.js
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
VOLUME ["/data"]
EXPOSE 8080 8081
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.INTERNAL_PORT}/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "/app/main.js"]
