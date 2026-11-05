# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src ./src
COPY scripts/write-scheduler-source-paths.mjs ./scripts/write-scheduler-source-paths.mjs
COPY scripts/bundle-jurisdiction-data.mjs ./scripts/bundle-jurisdiction-data.mjs
RUN node scripts/bundle-jurisdiction-data.mjs

# Remove test files before building (vitest not in prod deps)
RUN find src -name '*.test.ts' -delete -o -name '*.spec.ts' -delete

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy built files from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/data ./data
COPY data/jurisdiction/README.md ./data/jurisdiction/README.md

# Product Cloud Scheduler manifest, checked against source and live jobs at deploy.
COPY scheduler-jobs.json ./scheduler-jobs.json

# The hosted one-command onboarding bundle (GET /v1/bootstrap/agent.js). The
# canonical build artifact lives at provian-agent-sdk/dist-bundle/agent.js —
# outside this build context — so a byte-identical staged copy is checked in
# here; the sync tripwire is src/routes/bootstrap.bundle-sync.test.ts.
# Cache-bust: bump when the bundle changes so Cloud Build never reuses a cached
# image with a stale bundle (a bundle-only change reused the prior image).
ARG BUNDLE_REV=20261010-bug-security-fixes
COPY bootstrap-bundle ./bootstrap-bundle

# Set environment variables
ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=512
ENV PORT=8080
ENV BOOTSTRAP_BUNDLE_PATH=/app/bootstrap-bundle/agent.js

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Start the server
CMD ["node", "dist/server.js"]
