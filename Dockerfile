# Stage 1: Build Astro docs site from msp-claude-plugins
# CI clones wyre-technology/msp-claude-plugins and copies docs/ into build context
FROM node:20-alpine AS docs-builder

WORKDIR /docs
COPY docs/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
ARG DOCS_CACHE_BUST=0
COPY docs/ ./
ENV SITE_URL=https://mcp.wyretechnology.com
ENV BASE_PATH=/
RUN npm run build && \
    sed -i 's|https://wyre-technology.github.io/msp-claude-plugins/|https://mcp.wyretechnology.com/|g' dist/robots.txt

# Stage 2: Build gateway TypeScript
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Stage 3: Production runtime
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 gateway

COPY --from=builder /app/dist ./dist
COPY --from=docs-builder /docs/dist ./public
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

USER gateway

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

CMD ["node", "dist/index.js"]
