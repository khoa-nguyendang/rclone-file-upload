// Large file upload utilities with chunked upload support

// Type for API URL builder function
export type ApiUrlBuilder = (path: string) => string;

interface ChunkUploadOptions {
  file: File;
  path?: string;
  chunkSize?: number;
  onProgress?: (progress: number) => void;
  onChunkComplete?: (chunkNumber: number, totalChunks: number) => void;
  onError?: (error: Error) => void;
  onComplete?: (response: any) => void;
}

export class LargeFileUploader {
  private static readonly DEFAULT_CHUNK_SIZE = 64 * 1024 * 1024; // 64MB
  private static readonly MAX_RETRIES = 3;
  private static readonly LARGE_FILE_THRESHOLD = 100 * 1024 * 1024; // 100MB

  private abortController?: AbortController;
  private buildApiUrl: ApiUrlBuilder;

  constructor(buildApiUrl: ApiUrlBuilder) {
    this.buildApiUrl = buildApiUrl;
  }

  // Check if file should use chunked upload
  static shouldUseChunkedUpload(fileSize: number): boolean {
    return fileSize > this.LARGE_FILE_THRESHOLD;
  }

  // Upload file in chunks
  async uploadChunked(options: ChunkUploadOptions): Promise<void> {
    const {
      file,
      path = '/',
      chunkSize = LargeFileUploader.DEFAULT_CHUNK_SIZE,
      onProgress,
      onChunkComplete,
      onError,
      onComplete
    } = options;

    this.abortController = new AbortController();

    try {
      // Calculate total chunks
      const totalChunks = Math.ceil(file.size / chunkSize);

      // Step 1: Initiate multipart upload
      const initResponse = await fetch(this.buildApiUrl('/multipart/initiate'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filename: file.name,
          total_parts: totalChunks,
          file_size: file.size,
          path: path
        }),
        signal: this.abortController.signal
      });

      if (!initResponse.ok) {
        throw new Error(`Failed to initiate upload: ${initResponse.statusText}`);
      }

      const { session_id } = await initResponse.json();

      // Step 2: Upload chunks
      for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, file.size);
        const chunk = file.slice(start, end);
        const partNumber = i + 1;

        await this.uploadChunkWithRetry(
          chunk,
          session_id,
          partNumber,
          totalChunks,
          0
        );

        // Calculate and report progress
        const progress = ((i + 1) / totalChunks) * 100;
        onProgress?.(progress);
        onChunkComplete?.(partNumber, totalChunks);
      }

      onComplete?.({ success: true, message: 'Upload completed' });
    } catch (error) {
      if (error instanceof Error) {
        onError?.(error);
      }
      throw error;
    }
  }

  // Upload single chunk with retry logic
  private async uploadChunkWithRetry(
    chunk: Blob,
    sessionId: string,
    partNumber: number,
    totalParts: number,
    retryCount: number
  ): Promise<void> {
    try {
      const formData = new FormData();
      formData.append('chunk', chunk);
      formData.append('session_id', sessionId);
      formData.append('part_number', partNumber.toString());
      formData.append('total_parts', totalParts.toString());

      const response = await fetch(this.buildApiUrl('/multipart/upload-chunk'), {
        method: 'POST',
        body: formData,
        signal: this.abortController?.signal
      });

      if (!response.ok) {
        throw new Error(`Chunk upload failed: ${response.statusText}`);
      }
    } catch (error) {
      if (retryCount < LargeFileUploader.MAX_RETRIES) {
        // Retry with exponential backoff
        const delay = Math.pow(2, retryCount) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.uploadChunkWithRetry(
          chunk,
          sessionId,
          partNumber,
          totalParts,
          retryCount + 1
        );
      }
      throw error;
    }
  }

  // Upload using presigned URL (for very large files)
  async uploadWithPresignedUrl(
    file: File,
    path?: string,
    onProgress?: (progress: number) => void
  ): Promise<void> {
    try {
      // Get presigned URL from server
      const response = await fetch(this.buildApiUrl('/presigned-url'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filename: file.name,
          path: path
        })
      });

      if (!response.ok) {
        throw new Error('Failed to get presigned URL');
      }

      const { upload_url } = await response.json();

      // Upload directly to S3 using presigned URL
      const xhr = new XMLHttpRequest();

      return new Promise((resolve, reject) => {
        xhr.upload.addEventListener('progress', (event) => {
          if (event.lengthComputable) {
            const progress = (event.loaded / event.total) * 100;
            onProgress?.(progress);
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

        xhr.open('PUT', upload_url);
        xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
        xhr.send(file);
      });
    } catch (error) {
      throw error;
    }
  }

  // Abort ongoing upload
  abort(): void {
    this.abortController?.abort();
  }
}

// Helper function to format file size
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Helper to determine upload strategy
export function getUploadStrategy(fileSize: number): 'standard' | 'chunked' | 'presigned' {
  if (fileSize < 100 * 1024 * 1024) { // < 100MB
    return 'standard';
  } else if (fileSize < 5 * 1024 * 1024 * 1024) { // < 5GB
    return 'chunked';
  } else {
    return 'presigned'; // > 5GB
  }
}