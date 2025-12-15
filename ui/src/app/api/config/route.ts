// This API route serves runtime configuration to the client
// Server-side routes CAN read runtime environment variables
// This enables runtime environment injection without rebuilding the app

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic'; // Disable caching for runtime config

export async function GET() {
  // All configuration is read from runtime environment variables
  const config = {
    apiUrl: process.env.RUNTIME_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api',
    apiTimeout: parseInt(process.env.RUNTIME_API_TIMEOUT || process.env.NEXT_PUBLIC_API_TIMEOUT || '30000'),
    appName: process.env.RUNTIME_APP_NAME || process.env.NEXT_PUBLIC_APP_NAME || 'RClone File Browser',
    maxUploadSize: parseInt(process.env.RUNTIME_MAX_UPLOAD_SIZE || process.env.NEXT_PUBLIC_MAX_UPLOAD_SIZE || '104857600000'),
    enableDelete: (process.env.RUNTIME_ENABLE_DELETE || process.env.NEXT_PUBLIC_ENABLE_DELETE || 'true') === 'true',
    enableUpload: (process.env.RUNTIME_ENABLE_UPLOAD || process.env.NEXT_PUBLIC_ENABLE_UPLOAD || 'true') === 'true',
    defaultView: process.env.RUNTIME_DEFAULT_VIEW || process.env.NEXT_PUBLIC_DEFAULT_VIEW || 'tree',
    minioUrl: process.env.RUNTIME_MINIO_URL || process.env.NEXT_PUBLIC_MINIO_URL || 'http://minio:9000',
    minioConsoleUrl: process.env.RUNTIME_MINIO_CONSOLE_URL || process.env.NEXT_PUBLIC_MINIO_CONSOLE_URL || 'http://minio:9001',
    showHiddenFiles: (process.env.RUNTIME_SHOW_HIDDEN_FILES || process.env.NEXT_PUBLIC_SHOW_HIDDEN_FILES || 'false') === 'true',
    filePreviewEnabled: (process.env.RUNTIME_FILE_PREVIEW_ENABLED || process.env.NEXT_PUBLIC_FILE_PREVIEW_ENABLED || 'true') === 'true',
  };

  return NextResponse.json(config);
}