#!/bin/sh
# Docker entrypoint script for runtime environment injection
# This script runs at container startup to inject environment variables

set -e

echo "Starting UI with runtime environment configuration..."

# Log which runtime environment variables are set (without values for security)
echo "Runtime configuration:"
[ -n "$RUNTIME_API_URL" ] && echo "  - RUNTIME_API_URL is set"
[ -n "$RUNTIME_APP_NAME" ] && echo "  - RUNTIME_APP_NAME is set"
[ -n "$RUNTIME_MINIO_URL" ] && echo "  - RUNTIME_MINIO_URL is set"
[ -n "$RUNTIME_MINIO_CONSOLE_URL" ] && echo "  - RUNTIME_MINIO_CONSOLE_URL is set"
[ -n "$RUNTIME_MAX_UPLOAD_SIZE" ] && echo "  - RUNTIME_MAX_UPLOAD_SIZE is set"
[ -n "$RUNTIME_ENABLE_DELETE" ] && echo "  - RUNTIME_ENABLE_DELETE is set"
[ -n "$RUNTIME_ENABLE_UPLOAD" ] && echo "  - RUNTIME_ENABLE_UPLOAD is set"
[ -n "$RUNTIME_DEFAULT_VIEW" ] && echo "  - RUNTIME_DEFAULT_VIEW is set"

# Start the Next.js server
exec node server.js
