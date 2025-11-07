# Build stage
FROM golang:1.21-alpine AS builder

# Set working directory
WORKDIR /app

# Copy go mod files first (better caching)
COPY go.mod go.sum ./

# Download dependencies (cached if go.mod/go.sum unchanged)
RUN go mod download

# Copy only necessary source files (exclude init/, .env, etc.)
COPY *.go ./

# Build the application with optimizations
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -trimpath -o main .

# Final stage with Rclone
FROM alpine:latest

# Install Rclone and dependencies
# NOTE: fuse3 is required for rclone 1.62.0+ (uses fusermount3)
RUN apk add --no-cache \
    ca-certificates \
    fuse3 \
    curl \
    bash \
    unzip

# Install Rclone
RUN curl -O https://downloads.rclone.org/rclone-current-linux-amd64.zip && \
    unzip rclone-current-linux-amd64.zip && \
    cd rclone-*-linux-amd64 && \
    cp rclone /usr/bin/ && \
    chmod +x /usr/bin/rclone && \
    cd .. && \
    rm -rf rclone-*

WORKDIR /root/

# Copy the binary from builder
COPY --from=builder /app/main .

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Create storage mount point and rclone config directory
RUN mkdir -p /storage /root/.config/rclone

# Expose port
EXPOSE 8080

# Use entrypoint to mount storage via Rclone before starting server
ENTRYPOINT ["/entrypoint.sh"]