# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Set build-time environment variables BEFORE copying source
# These are DEFAULT values - they will be overridden by RUNTIME_* variables at container start
ENV NEXT_PUBLIC_API_URL=http://localhost:8080/api
ENV NEXT_PUBLIC_API_TIMEOUT=30000
ENV NEXT_PUBLIC_MINIO_URL=http://minio:9000
ENV NEXT_PUBLIC_MINIO_CONSOLE_URL=http://minio:9001
ENV NEXT_PUBLIC_APP_NAME="RClone File Browser"
ENV NEXT_PUBLIC_MAX_UPLOAD_SIZE=104857600000
ENV NEXT_PUBLIC_ENABLE_DELETE=true
ENV NEXT_PUBLIC_ENABLE_UPLOAD=true
ENV NEXT_PUBLIC_DEFAULT_VIEW=tree
ENV NEXT_PUBLIC_SHOW_HIDDEN_FILES=false
ENV NEXT_PUBLIC_FILE_PREVIEW_ENABLED=true

# These are for next.config.ts basePath and assetPrefix
# Leave empty for direct access (http://localhost:3000)
# Set to "/rclone-ui" if deploying behind a reverse proxy at /rclone-ui path
ENV BASE_PATH=""
ENV ASSET_PREFIX=""

# Copy source code AFTER setting ENV variables
COPY . .

# Build the application
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Copy built application from builder
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Copy entrypoint script
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENV NEXT_PUBLIC_API_URL=http://localhost:8080/api
ENV NEXT_PUBLIC_API_TIMEOUT=30000
ENV NEXT_PUBLIC_MAX_UPLOAD_SIZE=104857600000

# Expose port
EXPOSE 3000

# Start the application
ENTRYPOINT ["/docker-entrypoint.sh"]