// This API route serves configuration to the client
// Server-side routes CAN read runtime environment variables

import { NextResponse } from 'next/server';

export async function GET() {
  // These are read from runtime environment variables
  const config = {
    apiUrl: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api',
    apiTimeout: parseInt(process.env.NEXT_PUBLIC_API_TIMEOUT || '30000'),
    appName: process.env.NEXT_PUBLIC_APP_NAME || 'RClone File Browser',
    maxUploadSize: parseInt(process.env.NEXT_PUBLIC_MAX_UPLOAD_SIZE || '104857600'),
    enableDelete: process.env.NEXT_PUBLIC_ENABLE_DELETE === 'true',
    enableUpload: process.env.NEXT_PUBLIC_ENABLE_UPLOAD === 'true',
    defaultView: process.env.NEXT_PUBLIC_DEFAULT_VIEW || 'tree',
    minioConsoleUrl: process.env.NEXT_PUBLIC_MINIO_CONSOLE_URL || 'http://minio:9001',
  };

  return NextResponse.json(config);
}