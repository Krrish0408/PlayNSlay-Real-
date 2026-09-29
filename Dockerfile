# ==============================================================================
# Multi-Stage Production Dockerfile for Play N' Slay Gaming Lounge
# ==============================================================================

# Stage 1: Build dependencies & compilation
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies needed for build)
RUN npm ci

# Copy application source code
COPY . .

# Build the client (Vite) and server (esbuild)
RUN npm run build

# Prune devDependencies for production runtime
RUN npm prune --production

# Stage 2: Minimal Production Runtime
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5001

# Add non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 appuser

# Copy package metadata and production node_modules
COPY --from=builder --chown=appuser:nodejs /app/package*.json ./
COPY --from=builder --chown=appuser:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:nodejs /app/dist ./dist
COPY --from=builder --chown=appuser:nodejs /app/migrations ./migrations
COPY --from=builder --chown=appuser:nodejs /app/shared ./shared
COPY --from=builder --chown=appuser:nodejs /app/server ./server
COPY --from=builder --chown=appuser:nodejs /app/scripts ./scripts

# Create backups directory with proper permissions
RUN mkdir -p backups && chown -R appuser:nodejs backups

USER appuser

EXPOSE 5001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:5001/api/health/live || exit 1

CMD ["node", "dist/index.js"]
