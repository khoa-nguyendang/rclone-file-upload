// Application configuration from environment variables
// IMPORTANT: For client-side code, these values are replaced at BUILD TIME by Next.js

export const config = {
  api: {
    // Direct access allows Next.js to replace at build time
    url: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api',
    timeout: parseInt(process.env.NEXT_PUBLIC_API_TIMEOUT || '30000'),
  },
  minio: {
    url: process.env.NEXT_PUBLIC_MINIO_URL || 'http://minio:9000',
    consoleUrl: process.env.NEXT_PUBLIC_MINIO_CONSOLE_URL || 'http://minio:9001',
  },
  app: {
    name: process.env.NEXT_PUBLIC_APP_NAME || 'RClone File Browser',
    maxUploadSize: parseInt(process.env.NEXT_PUBLIC_MAX_UPLOAD_SIZE || '104857600000'),
    enableDelete: (process.env.NEXT_PUBLIC_ENABLE_DELETE || 'true') === 'true',
    enableUpload: (process.env.NEXT_PUBLIC_ENABLE_UPLOAD || 'true') === 'true',
  },
  ui: {
    defaultView: (process.env.NEXT_PUBLIC_DEFAULT_VIEW || 'tree') as 'tree' | 'flat',
    showHiddenFiles: (process.env.NEXT_PUBLIC_SHOW_HIDDEN_FILES || 'false') === 'true',
    filePreviewEnabled: (process.env.NEXT_PUBLIC_FILE_PREVIEW_ENABLED || 'true') === 'true',
  }
};

// Helper function to build API URLs
export const buildApiUrl = (path: string): string => {
  const baseUrl = config.api.url;
  const cleanPath = path.startsWith('/') ? path : `/${path}`;

  // If baseUrl already contains /api, don't add it again
  if (baseUrl.endsWith('/api')) {
    return `${baseUrl}${cleanPath}`;
  }

  return `${baseUrl}/api${cleanPath}`;
};