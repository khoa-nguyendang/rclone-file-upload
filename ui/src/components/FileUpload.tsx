'use client';

import { useApiUrl } from '@/lib/runtime-config';
import { LargeFileUploader, getUploadStrategy } from '@/lib/largeFileUploader';
import {
  CloudArrowUpIcon,
  DocumentIcon,
  FolderIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { useCallback, useRef, useState } from 'react';

interface FileUploadProps {
  currentPath: string;
  onUploadComplete: () => void;
}

interface UploadFile {
  file: File;
  progress: number;
  status: 'pending' | 'uploading' | 'complete' | 'error';
  error?: string;
}

export default function FileUpload({ currentPath, onUploadComplete }: FileUploadProps) {
  const buildApiUrl = useApiUrl();
  const [isDragging, setIsDragging] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<UploadFile[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [conflictAction, setConflictAction] = useState<'rename' | 'replace'>('rename');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      handleFiles(files);
    }
  }, []);

  const handleFiles = (files: File[]) => {
    const newFiles: UploadFile[] = files.map(file => ({
      file,
      progress: 0,
      status: 'pending' as const,
    }));
    setUploadQueue(prev => [...prev, ...newFiles]);

    // Start upload if not already uploading
    if (!isUploading) {
      uploadFiles(newFiles);
    }
  };

  const uploadFiles = async (files: UploadFile[]) => {
    setIsUploading(true);

    for (let i = 0; i < files.length; i++) {
      const uploadFile = files[i];

      // Update status to uploading
      setUploadQueue(prev =>
        prev.map(f =>
          f.file === uploadFile.file
            ? { ...f, status: 'uploading' as const }
            : f
        )
      );

      try {
        await uploadSingleFile(uploadFile.file, (progress) => {
          // Update progress
          setUploadQueue(prev =>
            prev.map(f =>
              f.file === uploadFile.file
                ? { ...f, progress }
                : f
            )
          );
        });

        // Mark as complete
        setUploadQueue(prev =>
          prev.map(f =>
            f.file === uploadFile.file
              ? { ...f, status: 'complete' as const, progress: 100 }
              : f
          )
        );
      } catch (error) {
        // Mark as error
        setUploadQueue(prev =>
          prev.map(f =>
            f.file === uploadFile.file
              ? { ...f, status: 'error' as const, error: error instanceof Error ? error.message : 'Upload failed' }
              : f
          )
        );
      }
    }

    setIsUploading(false);
    onUploadComplete();
  };

  const uploadSingleFile = async (file: File, onProgress: (progress: number) => void): Promise<void> => {
    // Determine upload strategy based on file size
    const strategy = getUploadStrategy(file.size);

    // Get the upload path
    let uploadPath = currentPath || '/';
    if (file.webkitRelativePath) {
      const relativePath = file.webkitRelativePath;
      const lastSlash = relativePath.lastIndexOf('/');
      const folderPath = lastSlash > 0 ? relativePath.substring(0, lastSlash) : '';
      uploadPath = currentPath && currentPath !== '/'
        ? `${currentPath}/${folderPath}`
        : `/${folderPath}`;
    }

    // Use chunked upload for files >= 100MB
    if (strategy === 'chunked' || strategy === 'presigned') {
      const uploader = new LargeFileUploader(buildApiUrl);

      try {
        if (strategy === 'presigned' && file.size > 5 * 1024 * 1024 * 1024) {
          // Use presigned URL for files > 5GB
          await uploader.uploadWithPresignedUrl(file, uploadPath, onProgress);
        } else {
          // Use chunked upload for files 100MB - 5GB
          await uploader.uploadChunked({
            file,
            path: uploadPath,
            onProgress,
            onChunkComplete: (chunkNum, totalChunks) => {
              console.log(`Uploaded chunk ${chunkNum}/${totalChunks} for ${file.name}`);
            }
          });
        }
      } catch (error) {
        throw error;
      }
    } else {
      // Use standard upload for files < 100MB
      return new Promise((resolve, reject) => {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('conflictAction', conflictAction);

        // If file has webkitRelativePath (from folder upload), preserve the directory structure
        if (file.webkitRelativePath) {
          formData.append('path', uploadPath);
          formData.append('preserveStructure', 'true');
        } else if (currentPath && currentPath !== '/') {
          formData.append('path', currentPath);
        }

        const xhr = new XMLHttpRequest();

        xhr.upload.addEventListener('progress', (event) => {
          if (event.lengthComputable) {
            const progress = Math.round((event.loaded / event.total) * 100);
            onProgress(progress);
          }
        });

        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(new Error(`Upload failed with status ${xhr.status}`));
          }
        });

        xhr.addEventListener('error', () => {
          reject(new Error('Network error during upload'));
        });

        xhr.open('POST', buildApiUrl('/upload'));
        xhr.send(formData);
      });
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      handleFiles(Array.from(files));
    }
    // Reset input
    e.target.value = '';
  };

  const removeFromQueue = (file: File) => {
    setUploadQueue(prev => prev.filter(f => f.file !== file));
  };

  const clearCompleted = () => {
    setUploadQueue(prev => prev.filter(f => f.status !== 'complete'));
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  return (
    <div className="mb-6">
      {/* Upload Area */}
      <div
        className={`border-2 border-dashed rounded-lg p-8 text-center transition-all
          ${isDragging ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-gray-400'}`}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <CloudArrowUpIcon className="mx-auto h-12 w-12 " />
        <p className="mt-2 text-sm ">
          Drag and drop files here, or use the buttons below
        </p>
        <p className="mt-1 text-xs text-gray-500">
          Folder upload preserves directory structure
        </p>

        {/* Conflict Resolution Options */}
        <div className="mt-3 flex justify-center items-center gap-4">
          <label className="text-xs ">If file exists:</label>
          <div className="flex gap-2">
            <label className="flex items-center text-xs">
              <input
                type="radio"
                name="conflictAction"
                value="rename"
                checked={conflictAction === 'rename'}
                onChange={() => setConflictAction('rename')}
                className="mr-1"
              />
              Rename with UUID
            </label>
            <label className="flex items-center text-xs">
              <input
                type="radio"
                name="conflictAction"
                value="replace"
                checked={conflictAction === 'replace'}
                onChange={() => setConflictAction('replace')}
                className="mr-1"
              />
              Replace existing
            </label>
          </div>
        </div>

        <div className="mt-4 flex justify-center gap-4">
          <button
            onClick={(e) => {
              e.stopPropagation();
              fileInputRef.current?.click();
            }}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            Select Files
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              folderInputRef.current?.click();
            }}
            className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
          >
            Select Folder
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileSelect}
          className="hidden"
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          // @ts-ignore - webkitdirectory is not in TypeScript types
          webkitdirectory=""
          onChange={handleFileSelect}
          className="hidden"
        />
      </div>

      {/* Upload Queue */}
      {uploadQueue.length > 0 && (
        <div className="mt-6 bg-white rounded-lg shadow-md p-4">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-semibold">Upload Queue ({uploadQueue.length})</h3>
            {uploadQueue.some(f => f.status === 'complete') && (
              <button
                onClick={clearCompleted}
                className="text-sm text-blue-600 hover:text-blue-800"
              >
                Clear Completed
              </button>
            )}
          </div>

          <div className="space-y-2 max-h-64 overflow-y-auto">
            {uploadQueue.map((uploadFile, index) => (
              <div key={index} className="border rounded-lg p-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-start space-x-3 flex-1">
                    {uploadFile.file.type.includes('folder') || uploadFile.file.webkitRelativePath ? (
                      <FolderIcon className="h-5 w-5 text-blue-600 mt-0.5" />
                    ) : (
                      <DocumentIcon className="h-5 w-5  mt-0.5" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {uploadFile.file.webkitRelativePath || uploadFile.file.name}
                      </p>
                      <p className="text-xs">
                        {formatFileSize(uploadFile.file.size)}
                      </p>

                      {/* Progress Bar */}
                      {uploadFile.status === 'uploading' && (
                        <div className="mt-2">
                          <div className="flex justify-between text-xs  mb-1">
                            <span>Uploading...</span>
                            <span>{uploadFile.progress}%</span>
                          </div>
                          <div className="w-full bg-gray-200 rounded-full h-2">
                            <div
                              className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                              style={{ width: `${uploadFile.progress}%` }}
                            />
                          </div>
                        </div>
                      )}

                      {/* Status */}
                      {uploadFile.status === 'complete' && (
                        <p className="mt-1 text-xs text-green-600">✓ Complete</p>
                      )}
                      {uploadFile.status === 'error' && (
                        <p className="mt-1 text-xs text-red-600">✗ {uploadFile.error}</p>
                      )}
                      {uploadFile.status === 'pending' && (
                        <p className="mt-1 text-xs text-gray-500">Waiting...</p>
                      )}
                    </div>
                  </div>

                  {/* Remove button */}
                  {(uploadFile.status === 'pending' || uploadFile.status === 'error' || uploadFile.status === 'complete') && (
                    <button
                      onClick={() => removeFromQueue(uploadFile.file)}
                      className="ml-2 p-1  hover:"
                    >
                      <XMarkIcon className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}