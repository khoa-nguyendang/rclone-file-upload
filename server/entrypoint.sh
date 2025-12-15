#!/bin/bash
set -e

echo "=== RClone Storage Configuration ==="
echo "  Type: ${STORAGE_TYPE:-s3}"
echo "  Provider: ${STORAGE_PROVIDER:-Minio}"
echo "  Endpoint: ${STORAGE_ENDPOINT:-minio:9000}"
echo "  Bucket: ${STORAGE_BUCKET:-rclone}"
echo "=================================="

# Create rclone configuration from environment variables
mkdir -p /root/.config/rclone

# Determine the endpoint URL with proper protocol
ENDPOINT_HOST="${STORAGE_ENDPOINT:-minio:9000}"
if [ "${STORAGE_USE_SSL}" = "true" ]; then
    ENDPOINT_URL="https://${ENDPOINT_HOST}"
else
    ENDPOINT_URL="http://${ENDPOINT_HOST}"
fi

cat > /root/.config/rclone/rclone.conf <<EOF
[storage]
type = ${STORAGE_TYPE:-s3}
provider = ${STORAGE_PROVIDER:-Minio}
endpoint = ${ENDPOINT_URL}
access_key_id = ${STORAGE_ACCESS_KEY:-rclone}
secret_access_key = ${STORAGE_SECRET_KEY:-rclone123}
env_auth = false
force_path_style = true
EOF

# For AWS S3, add region
if [ -n "${STORAGE_REGION}" ]; then
    echo "region = ${STORAGE_REGION}" >> /root/.config/rclone/rclone.conf
fi

echo ""
echo "Rclone configuration created:"
cat /root/.config/rclone/rclone.conf
echo ""

# Configure FUSE for --allow-other
echo "Configuring FUSE..."
if [ -f /etc/fuse.conf ]; then
    # Ensure user_allow_other is enabled
    if ! grep -q "user_allow_other" /etc/fuse.conf; then
        echo "user_allow_other" >> /etc/fuse.conf
        echo "Added user_allow_other to /etc/fuse.conf"
    else
        echo "user_allow_other already configured"
    fi
else
    # Create fuse.conf if it doesn't exist
    echo "user_allow_other" > /etc/fuse.conf
    echo "Created /etc/fuse.conf with user_allow_other"
fi
echo ""

# Test connectivity to storage endpoint first
echo "Testing connectivity to storage endpoint..."
if timeout 10 rclone lsd storage: 2>/dev/null; then
    echo "Successfully connected to storage endpoint"
else
    echo "WARNING: Cannot connect to storage endpoint yet. Will retry during mount..."
fi
echo ""

# Mount storage using Rclone (run in background, not daemon mode)
echo "Mounting storage to /storage via Rclone..."
rclone mount storage:${STORAGE_BUCKET:-rclone} /storage \
    --allow-other \
    --vfs-cache-mode writes \
    --vfs-cache-max-age 1h \
    --vfs-cache-max-size 1G \
    --dir-cache-time 5m \
    --buffer-size 64M \
    --log-level INFO \
    --log-file /tmp/rclone-mount.log \
    --poll-interval 15s \
    --transfers 4 &

RCLONE_PID=$!
echo "RClone process started with PID: $RCLONE_PID"

# Wait for mount with better detection
echo "Waiting for mount to be ready..."
MOUNT_SUCCESS=false
for i in {1..30}; do
    if mountpoint -q /storage 2>/dev/null; then
        echo "Storage mounted successfully via Rclone"
        if ls -la /storage 2>/dev/null; then
            echo "Mount is accessible and working"
        else
            echo "Mount is ready but bucket may be empty or inaccessible"
        fi
        MOUNT_SUCCESS=true
        break
    fi

    # Check if rclone process is still running
    if ! kill -0 $RCLONE_PID 2>/dev/null; then
        echo "✗ ERROR: Rclone process died unexpectedly"
        break
    fi

    echo "  Waiting for mount... attempt $i/30"
    sleep 2
done

if [ "$MOUNT_SUCCESS" = false ]; then
    echo ""
    echo "✗ ERROR: Rclone mount failed after 60 seconds"
    echo ""
    echo "=== Rclone Mount Log ==="
    cat /tmp/rclone-mount.log 2>/dev/null || echo "No log file found"
    echo "========================"
    echo ""
    echo "Troubleshooting tips:"
    echo "1. Check that MinIO is running and accessible"
    echo "2. Verify STORAGE_ACCESS_KEY and STORAGE_SECRET_KEY are correct"
    echo "3. Ensure the bucket '${STORAGE_BUCKET:-rclone}' exists"
    echo "4. Check Docker container has --privileged flag and /dev/fuse"
    exit 1
fi

echo ""
echo "=== RClone mount successful! ==="
echo ""

# Start the Go application
echo "Starting server on port ${SERVER_PORT:-8080}..."
exec /root/main
