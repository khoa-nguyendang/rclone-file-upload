'use client';

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

// Runtime configuration interface
export interface RuntimeConfig {
  api: {
    url: string;
    timeout: number;
  };
  minio: {
    url: string;
    consoleUrl: string;
  };
  app: {
    name: string;
    maxUploadSize: number;
    enableDelete: boolean;
    enableUpload: boolean;
  };
  ui: {
    defaultView: 'tree' | 'flat';
    showHiddenFiles: boolean;
    filePreviewEnabled: boolean;
  };
}

// Default configuration (fallback values)
const defaultConfig: RuntimeConfig = {
  api: {
    url: 'http://localhost:8080/api',
    timeout: 30000,
  },
  minio: {
    url: 'http://minio:9000',
    consoleUrl: 'http://minio:9001',
  },
  app: {
    name: 'RClone File Browser',
    maxUploadSize: 104857600000,
    enableDelete: true,
    enableUpload: true,
  },
  ui: {
    defaultView: 'tree',
    showHiddenFiles: false,
    filePreviewEnabled: true,
  },
};

// Extend Window interface for runtime config injection
declare global {
  interface Window {
    __RUNTIME_CONFIG__?: Partial<RuntimeConfig>;
  }
}

// Context for runtime configuration
const RuntimeConfigContext = createContext<RuntimeConfig>(defaultConfig);

// Hook to access runtime configuration
export function useRuntimeConfig(): RuntimeConfig {
  return useContext(RuntimeConfigContext);
}

// Hook to build API URLs using runtime config
export function useApiUrl() {
  const config = useRuntimeConfig();

  return useCallback((path: string): string => {
    const baseUrl = config.api.url;
    const cleanPath = path.startsWith('/') ? path : `/${path}`;

    // If baseUrl already contains /api, don't add it again
    if (baseUrl.endsWith('/api')) {
      return `${baseUrl}${cleanPath}`;
    }

    return `${baseUrl}/api${cleanPath}`;
  }, [config.api.url]);
}

interface RuntimeConfigProviderProps {
  children: React.ReactNode;
}

// Provider component that loads configuration at runtime
export function RuntimeConfigProvider({ children }: RuntimeConfigProviderProps) {
  const [config, setConfig] = useState<RuntimeConfig>(defaultConfig);
  const [isLoading, setIsLoading] = useState(true);
  const [isMounted, setIsMounted] = useState(false);

  // Track client-side mount to avoid SSR issues
  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    // Only fetch config on client side after mount
    if (!isMounted) return;

    async function loadConfig() {
      try {
        // First, check for window.__RUNTIME_CONFIG__ (injected by server)
        if (typeof window !== 'undefined' && window.__RUNTIME_CONFIG__) {
          const injectedConfig = window.__RUNTIME_CONFIG__;
          setConfig(prev => mergeConfig(prev, injectedConfig));
          setIsLoading(false);
          return;
        }

        // Fallback: fetch from API route
        const response = await fetch('/api/config');
        if (response.ok) {
          const data = await response.json();
          setConfig(prev => mergeConfig(prev, data));
        }
      } catch (error) {
        console.warn('Failed to load runtime config, using defaults:', error);
      } finally {
        setIsLoading(false);
      }
    }

    loadConfig();
  }, [isMounted]);

  // During SSR or before mount, render children with default config
  // This prevents hydration mismatches and build errors
  if (!isMounted) {
    return (
      <RuntimeConfigContext.Provider value={defaultConfig}>
        {children}
      </RuntimeConfigContext.Provider>
    );
  }

  // Show loading spinner while fetching config on client
  if (isLoading) {
    return (
      <RuntimeConfigContext.Provider value={defaultConfig}>
        <div className="min-h-screen flex items-center justify-center bg-gray-50">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      </RuntimeConfigContext.Provider>
    );
  }

  return (
    <RuntimeConfigContext.Provider value={config}>
      {children}
    </RuntimeConfigContext.Provider>
  );
}

// Helper function to merge partial config with defaults
function mergeConfig(defaults: RuntimeConfig, partial: Partial<RuntimeConfig> | Record<string, unknown>): RuntimeConfig {
  // Handle flat API response format
  if ('apiUrl' in partial) {
    return {
      api: {
        url: (partial.apiUrl as string) || defaults.api.url,
        timeout: (partial.apiTimeout as number) || defaults.api.timeout,
      },
      minio: {
        url: (partial.minioUrl as string) || defaults.minio.url,
        consoleUrl: (partial.minioConsoleUrl as string) || defaults.minio.consoleUrl,
      },
      app: {
        name: (partial.appName as string) || defaults.app.name,
        maxUploadSize: (partial.maxUploadSize as number) || defaults.app.maxUploadSize,
        enableDelete: partial.enableDelete !== undefined ? (partial.enableDelete as boolean) : defaults.app.enableDelete,
        enableUpload: partial.enableUpload !== undefined ? (partial.enableUpload as boolean) : defaults.app.enableUpload,
      },
      ui: {
        defaultView: ((partial.defaultView as string) || defaults.ui.defaultView) as 'tree' | 'flat',
        showHiddenFiles: partial.showHiddenFiles !== undefined ? (partial.showHiddenFiles as boolean) : defaults.ui.showHiddenFiles,
        filePreviewEnabled: partial.filePreviewEnabled !== undefined ? (partial.filePreviewEnabled as boolean) : defaults.ui.filePreviewEnabled,
      },
    };
  }

  // Handle nested config format (from window.__RUNTIME_CONFIG__)
  return {
    api: {
      ...defaults.api,
      ...(partial.api || {}),
    },
    minio: {
      ...defaults.minio,
      ...(partial.minio || {}),
    },
    app: {
      ...defaults.app,
      ...(partial.app || {}),
    },
    ui: {
      ...defaults.ui,
      ...(partial.ui || {}),
    },
  };
}
