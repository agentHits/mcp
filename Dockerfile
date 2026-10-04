# ----- Build Stage -----
FROM oven/bun:1.4.2 AS builder
WORKDIR /app

# Copy package and configuration
COPY package.json bun.lock tsconfig.json ./

# Copy source code
COPY src ./src

# Install dependencies and build
RUN bun install --frozen-lockfile && bun run build

# ----- Production Stage -----
FROM oven/bun:1.4.2-slim
WORKDIR /app

# Copy bundled build (no runtime dependencies needed)
COPY --from=builder /app/build ./build

# Expose port 3000 (internal container port)
EXPOSE 3000

# Add health check for HTTP mode
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD if [ "$MCP_TRANSPORT" = "http" ] || [ "$MCP_TRANSPORT" = "sse" ]; then \
        bun -e "fetch('http://localhost:3000/health').then((r) => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))" || exit 1; \
      else \
        exit 0; \
      fi

# Default command supports both stdio and HTTP modes
CMD ["bun", "build/index.js"]
