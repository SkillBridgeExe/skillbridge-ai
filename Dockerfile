# =========================================================================
# Multi-stage Dockerfile for Cloud Run deployment.
# =========================================================================

# ----- Stage 1: build -----
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ----- Stage 2: production -----
FROM node:20-alpine AS production

ENV NODE_ENV=production

WORKDIR /app

# Only install production deps
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prompts ./prompts

# Cloud Run injects PORT env var
EXPOSE 8080

CMD ["node", "dist/main"]
