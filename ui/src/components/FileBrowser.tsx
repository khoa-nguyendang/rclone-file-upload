'use client';

import { buildApiUrl, config } from '@/lib/config';
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ChevronRightIcon,
  DocumentIcon,
  FolderIcon,
  HomeIcon,
  TrashIcon
} from '@heroicons/react/24/outline';
import { useState } from 'react';

interface FileItem {
  name: string;
  size: number;
  modified: string;
  is_dir: boolean;
  path: string;
}

interface FileBrowserProps {
  files: FileItem[];
  currentPath: string;
  onNavigate: (path: string) => void;
  onRefresh: () => void;
}

export default function FileBrowser({
  files,
  currentPath,
  onNavigate,
  onRefresh
}: FileBrowserProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  const formatDate = (dateString: string): string => {
    const date = new Date(dateString);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  };

  const handleItemClick = (item: FileItem) => {
    if (item.is_dir) {
      const newPath = currentPath === '/'
        ? `/${item.name}`
        : `${currentPath}/${item.name}`;
      onNavigate(newPath);
    } else {
      setSelectedFile(item.name);
    }
  };

  const handleDownload = (filePath: string) => {
    // Remove leading slash for the download URL
    const cleanPath = filePath.startsWith('/') ? filePath.substring(1) : filePath;
    // eslint-disable-next-line react-hooks/immutability
    window.location.href = buildApiUrl(`/download/${encodeURIComponent(cleanPath)}`);
  };

  const handleDelete = async (filePath: string, fileName: string) => {
    if (!config.app.enableDelete) return;

    if (!confirm(`Are you sure you want to delete ${fileName}?`)) {
      return;
    }

    try {
      // Remove leading slash for the delete URL
      const cleanPath = filePath.startsWith('/') ? filePath.substring(1) : filePath;
      const response = await fetch(buildApiUrl(`/delete/${encodeURIComponent(cleanPath)}`), {
        method: 'DELETE',
      });

      if (response.ok) {
        onRefresh(); // Refresh the file list after deletion
      } else {
        const errorText = await response.text();
        console.error('Delete failed:', errorText);
        alert(`Failed to delete file: ${errorText}`);
      }
    } catch (error) {
      console.error('Error deleting file:', error);
      alert('Error deleting file');
    }
  };

  const pathSegments = currentPath.split('/').filter(Boolean);

  return (
    <div className="bg-white rounded-lg shadow-md">
      {/* Toolbar */}
      <div className="border-b border-gray-200 p-4">
        <div className="flex items-center justify-between">
          {/* Breadcrumb */}
          <div className="flex items-center space-x-2">
            <button
              onClick={() => onNavigate('/')}
              className="text-blue-600 hover:text-blue-800 transition-colors"
            >
              <HomeIcon className="h-5 w-5" />
            </button>
            {pathSegments.map((segment, index) => {
              const path = '/' + pathSegments.slice(0, index + 1).join('/');
              return (
                <div key={index} className="flex items-center">
                  <ChevronRightIcon className="h-4 w-4 text-gray-400 mx-1" />
                  <button
                    onClick={() => onNavigate(path)}
                    className="text-blue-600 hover:text-blue-800 transition-colors"
                  >
                    {segment}
                  </button>
                </div>
              );
            })}
          </div>

          {/* Actions */}
          <button
            onClick={onRefresh}
            className="p-2 text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded-lg transition-all"
            title="Refresh"
          >
            <ArrowPathIcon className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* File List */}
      <div className="divide-y divide-gray-200">
        {files.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            No files or folders in this directory
          </div>
        ) : (
          files.map((item, index) => (
            <div
              key={index}
              className={`p-4 hover:bg-gray-50 cursor-pointer transition-colors ${
                selectedFile === item.name ? 'bg-blue-50' : ''
              }`}
              onClick={() => handleItemClick(item)}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  {item.is_dir ? (
                    <FolderIcon className="h-6 w-6 text-blue-600" />
                  ) : (
                    <DocumentIcon className="h-6 w-6 text-gray-400" />
                  )}
                  <div>
                    <div className="font-medium text-gray-900">
                      {item.name}
                    </div>
                    <div className="text-sm text-gray-500">
                      {item.is_dir ? 'Folder' : formatFileSize(item.size)}
                      {' • '}
                      {formatDate(item.modified)}
                    </div>
                  </div>
                </div>

                {!item.is_dir && (
                  <div className="flex space-x-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDownload(item.path);
                      }}
                      className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors flex items-center space-x-1"
                      title="Download"
                    >
                      <ArrowDownTrayIcon className="h-4 w-4" />
                      <span>Download</span>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(item.path, item.name);
                      }}
                      className="px-3 py-1 text-sm bg-red-600 text-white rounded hover:bg-red-700 transition-colors flex items-center space-x-1"
                      title="Delete"
                    >
                      <TrashIcon className="h-4 w-4" />
                      <span>Delete</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}