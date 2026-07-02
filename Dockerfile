# be10x board server — serves the prebuilt web UI (public/) + the HTTP API + the baked-in agent runner.
# The web app is built ahead of time into public/ (committed), so this image only runs the Node server.
FROM node:22-bookworm-slim

# Runtime + build tools: git (the agent works in git worktrees) and the toolchain better-sqlite3 needs to
# compile its native addon during install. ca-certificates so outbound TLS (Anthropic API) works.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install server deps first for layer caching. Only the root deps are needed at runtime (the UI is
# prebuilt into public/), so we never install web/ or run Vite in the image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# The Claude Code CLI the runner spawns per agent task, pinned to match src/executor/claude-adapter.js.
RUN npm install -g @anthropic-ai/claude-code@2.1.197

# App source (see .dockerignore for exclusions).
COPY . .

ENV NODE_ENV=production \
    GFA_DB_PATH=/data/be10x.db \
    GFA_CLAUDE_BIN=claude \
    GFA_SECURE_COOKIES=1

# The SQLite DB (and any repos/worktrees you mount) live on a volume so state survives restarts.
VOLUME ["/data"]
EXPOSE 4610

CMD ["node", "bin/be10x.js", "serve", "--host", "0.0.0.0", "--port", "4610"]
