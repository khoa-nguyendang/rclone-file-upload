# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Set build-time environment variables BEFORE copying source
# These MUST be ENV, not just ARG, for Next.js to use them
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
ENV BASE_PATH="/rclone-ui"
ENV ASSET_PREFIX="/rclone-ui"

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

# Runtime ENV for server-side rendering (SSR) and API routes
# These can be overridden at runtime for server-side code
ENV NEXT_PUBLIC_API_URL=http://localhost:8080/api
ENV NEXT_PUBLIC_API_TIMEOUT=30000
ENV NEXT_PUBLIC_MAX_UPLOAD_SIZE=104857600000

# Expose port
EXPOSE 3000

# Start the application
CMD ["node", "server.js"]