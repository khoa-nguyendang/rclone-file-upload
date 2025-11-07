'use client';

import FileBrowser from '@/components/FileBrowser';
import FileUpload from '@/components/FileUpload';
import StorageStats from '@/components/StorageStats';
import TreeView from '@/components/TreeView';
import { buildApiUrl, config } from '@/lib/config';
import { ListBulletIcon, Squares2X2Icon } from '@heroicons/react/24/outline';
import { useEffect, useState } from 'react';

interface FileItem {
  name: string;
  size: number;
  modified: string;
  is_dir: boolean;
  path: string;
}

type ViewMode = 'tree' | 'flat';

export default function Home() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [currentPath, setCurrentPath] = useState('/');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(config.ui.defaultView);

  useEffect(() => {
    if (viewMode === 'flat') {
      loadFiles(currentPath);
    }
  }, [currentPath, viewMode]);

  const loadFiles = async (path: string) => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(buildApiUrl(`/list?path=${encodeURIComponent(path)}`));
      if (!response.ok) {
        throw new Error('Failed to load files');
      }
      const data = await response.json();
      setFiles(data || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      setFiles([]);
    } finally {
      setLoading(false);
    }
  };

  const handleNavigate = (path: string) => {
    setCurrentPath(path);
  };

  const handleRefresh = () => {
    if (viewMode === 'flat') {
      loadFiles(currentPath);
    }
    // TreeView has its own refresh mechanism
  };

  const handleViewModeChange = (mode: ViewMode) => {
    setViewMode(mode);
    if (mode === 'flat') {
      loadFiles(currentPath);
    }
  };

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="container mx-auto px-4 py-8">
        <header className="mb-8">
          <div className="flex justify-between items-start">
            <div>
              <h1 className="text-4xl font-bold text-gray-800 mb-2">
                {config.app.name}
              </h1>
              <p className="text-gray-600">
                Browse files stored in MinIO through RClone
              </p>
            </div>

            {/* View Mode Toggle */}
            <div className="flex bg-white rounded-lg shadow-sm border border-gray-200">
              <button
                onClick={() => handleViewModeChange('tree')}
                className={`flex items-center px-4 py-2 text-sm font-medium rounded-l-lg transition-colors ${
                  viewMode === 'tree'
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-700 hover:bg-gray-50'
                }`}
                title="Tree View"
              >
                <Squares2X2Icon className="h-5 w-5 mr-2" />
                Tree View
              </button>
              <button
                onClick={() => handleViewModeChange('flat')}
                className={`flex items-center px-4 py-2 text-sm font-medium rounded-r-lg transition-colors ${
                  viewMode === 'flat'
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-700 hover:bg-gray-50'
                }`}
                title="Flat View"
              >
                <ListBulletIcon className="h-5 w-5 mr-2" />
                Flat View
              </button>
            </div>
          </div>
        </header>

        {/* Storage Statistics */}
        <StorageStats />

        {/* Upload Section - Always visible if enabled */}
        {config.app.enableUpload && (
          <FileUpload
            currentPath={viewMode === 'flat' ? currentPath : '/'}
            onUploadComplete={handleRefresh}
          />
        )}

        {/* Loading State */}
        {loading && viewMode === 'flat' && (
          <div className="flex justify-center items-center py-12">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
          </div>
        )}

        {/* Error State */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4">
            Error: {error}
          </div>
        )}

        {/* File Browser Based on View Mode */}
        {!loading && !error && (
          <>
            {viewMode === 'tree' ? (
              <TreeView
                onFileSelect={(file) => console.log('File selected:', file)}
                onRefresh={handleRefresh}
              />
            ) : (
              <FileBrowser
                files={files}
                currentPath={currentPath}
                onNavigate={handleNavigate}
                onRefresh={handleRefresh}
              />
            )}
          </>
        )}

        {/* Footer with useful links */}
        <footer className="mt-12 pt-8 border-t border-gray-200 text-center text-sm text-gray-500">
          <div className="flex justify-center space-x-6">
            <a
              href={config.minio.consoleUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-blue-600 transition-colors"
            >
              MinIO Console →
            </a>
            <span>•</span>
            <a
              href={`${config.api.url}/api/health`}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-blue-600 transition-colors"
            >
              API Health →
            </a>
            <span>•</span>
            <span>Max Upload: {Math.round(config.app.maxUploadSize / 1024 / 1024)} GB</span>
          </div>
        </footer>
      </div>
    </main>
  );
}