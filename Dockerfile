# Container image used by MCP directories (e.g. Glama) to start Quilt's MCP
# server for hosted introspection. This is not part of how Quilt is normally
# installed or run; end users install `@quilt-dev/cli` from npm.

FROM node:22-slim

# Git is required: Quilt tracks per-line authorship inside a Git checkout.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

# Build Quilt from source so the image matches the indexed repository.
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Quilt only serves inside an initialized Git checkout, so prepare a throwaway
# workspace at build time. This lets the MCP server start and answer
# introspection in a fresh container with no manual setup.
WORKDIR /workspace
RUN git config --global user.email "mcp@quilt.dev" \
    && git config --global user.name "quilt-mcp" \
    && git init -q \
    && node /app/dist/cli.js init

# The MCP server speaks JSON-RPC over stdio.
CMD ["node", "/app/dist/cli.js", "mcp"]
