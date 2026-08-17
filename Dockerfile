# Multi-stage build.
#
# Why multi-stage (Q169): the final image should contain the compiled output and production
# dependencies only — not the TypeScript compiler, not devDependencies, not source files.
# A single-stage build ships all of it, which is a larger image, a slower pull, and a wider
# attack surface for no benefit.

# ── deps ──────────────────────────────────────────────────────────────────────
# Separate stage so the dependency layer is cached independently of source changes.
# Copying package files *before* the source is the whole point: editing a .ts file
# must not invalidate the layer that ran `npm ci`.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# ── development ───────────────────────────────────────────────────────────────
# Target used by docker-compose's `full` profile. Keeps devDependencies so the Nest
# CLI and its watcher are available; source arrives via a bind mount, not COPY.
FROM node:24-alpine AS development
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
CMD ["npm", "run", "start:dev"]

# ── build ─────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && npm prune --omit=dev

# ── production ────────────────────────────────────────────────────────────────
FROM node:24-alpine AS production
WORKDIR /app
ENV NODE_ENV=production

# Don't run as root. The node image ships an unprivileged `node` user; use it.
# A container escape from a root process is a host root process.
USER node

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./

EXPOSE 3000
CMD ["node", "dist/main.js"]
