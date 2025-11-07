package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/minio/madmin-go/v3"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

type FileInfo struct {
	Name     string    `json:"name"`
	Path     string    `json:"path"`
	IsDir    bool      `json:"is_dir"`
	Size     int64     `json:"size"`
	Modified time.Time `json:"modified"`
}

type UploadResponse struct {
	Success        bool   `json:"success"`
	Path           string `json:"path"`
	Message        string `json:"message,omitempty"`
	FileExists     bool   `json:"file_exists,omitempty"`
	OriginalName   string `json:"original_name,omitempty"`
	RenamedTo      string `json:"renamed_to,omitempty"`
	ConflictAction string `json:"conflict_action,omitempty"`
}

var minioClient *minio.Client
var coreClient *minio.Core
var madminClient *madmin.AdminClient
var bucketName = "rclone"

func initMinIO() error {
	endpoint := os.Getenv("MINIO_ENDPOINT")
	if endpoint == "" {
		endpoint = "minio:9000"
	}

	accessKeyID := os.Getenv("MINIO_ACCESS_KEY")
	if accessKeyID == "" {
		accessKeyID = "rclone"
	}

	secretAccessKey := os.Getenv("MINIO_SECRET_KEY")
	if secretAccessKey == "" {
		secretAccessKey = "rclone123"
	}

	minioBucketName := os.Getenv("MINIO_BUCKET")
	if minioBucketName != "" {
		bucketName = minioBucketName
	}

	useSSL := os.Getenv("MINIO_USE_SSL") == "true"

	var err error
	minioClient, err = minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKeyID, secretAccessKey, ""),
		Secure: useSSL,
	})
	if err != nil {
		return fmt.Errorf("failed to create MinIO client: %w", err)
	}

	// Create Core client for multipart operations
	coreClient, err = minio.NewCore(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKeyID, secretAccessKey, ""),
		Secure: useSSL,
	})
	if err != nil {
		return fmt.Errorf("failed to create MinIO Core client: %w", err)
	}

	// Create Admin client for fast stats (DataUsageInfo)
	madminClient, err = madmin.New(endpoint, accessKeyID, secretAccessKey, useSSL)
	if err != nil {
		log.Printf("Warning: Failed to create MinIO Admin client: %v (stats will use ListObjects)", err)
		madminClient = nil // Continue without admin client
	} else {
		log.Printf("MinIO Admin client initialized successfully")
	}

	// Check if bucket exists, create if not
	ctx := context.Background()
	exists, err := minioClient.BucketExists(ctx, bucketName)
	if err != nil {
		return fmt.Errorf("failed to check bucket existence: %w", err)
	}

	if !exists {
		err = minioClient.MakeBucket(ctx, bucketName, minio.MakeBucketOptions{})
		if err != nil {
			return fmt.Errorf("failed to create bucket: %w", err)
		}
		log.Printf("Created bucket: %s", bucketName)
	}

	log.Printf("MinIO client initialized successfully. Endpoint: %s, Bucket: %s", endpoint, bucketName)
	return nil
}

// checkFileExists checks if an object exists in MinIO
func checkFileExists(objectKey string) bool {
	ctx := context.Background()
	_, err := minioClient.StatObject(ctx, bucketName, objectKey, minio.StatObjectOptions{})
	return err == nil
}

// generateUniqueFilename generates a unique filename by adding a UUID or timestamp
func generateUniqueFilename(originalPath string) string {
	dir := filepath.Dir(originalPath)
	filename := filepath.Base(originalPath)
	ext := filepath.Ext(filename)
	nameWithoutExt := strings.TrimSuffix(filename, ext)

	// Generate a short UUID (first 8 characters)
	shortUUID := uuid.New().String()[:8]

	// Create new filename with UUID
	newFilename := fmt.Sprintf("%s_%s%s", nameWithoutExt, shortUUID, ext)

	if dir == "." || dir == "/" {
		return newFilename
	}
	return path.Join(dir, newFilename)
}

func corsMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Allow requests from the UI container
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Max-Age", "3600")

		// Handle preflight requests
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	}
}

func uploadHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Parse multipart form
	// Note: This is the max memory to use, not the max file size
	// Files larger than this are stored in temporary files on disk
	err := r.ParseMultipartForm(100 << 20) // 100 MB memory buffer
	if err != nil {
		log.Printf("Failed to parse form: %v", err)
		http.Error(w, "Failed to parse form", http.StatusBadRequest)
		return
	}

	file, handler, err := r.FormFile("file")
	if err != nil {
		log.Printf("Failed to get file from form: %v", err)
		http.Error(w, "Failed to get file", http.StatusBadRequest)
		return
	}
	defer file.Close()

	// Get the upload path from form
	uploadPath := r.FormValue("path")
	if uploadPath == "" {
		uploadPath = "/"
	}

	// Get conflict resolution strategy (replace or rename)
	// Default to "rename" for safety
	conflictAction := r.FormValue("conflictAction")
	if conflictAction == "" {
		conflictAction = "rename" // Default behavior
	}

	// Clean and prepare the object key
	// If uploadPath is /, don't add it as prefix
	var objectKey string
	if uploadPath == "/" || uploadPath == "" {
		objectKey = handler.Filename
	} else {
		// Clean the path and ensure it doesn't start with /
		uploadPath = strings.TrimPrefix(filepath.Clean(uploadPath), "/")
		objectKey = path.Join(uploadPath, handler.Filename)
	}

	// Ensure the object key doesn't start with /
	objectKey = strings.TrimPrefix(objectKey, "/")
	originalKey := objectKey

	// Check if file exists and handle conflict
	fileExists := checkFileExists(objectKey)
	var conflictHandled string

	if fileExists {
		if conflictAction == "replace" {
			// User chose to replace - proceed with upload
			log.Printf("File exists, replacing: %s", objectKey)
			conflictHandled = "replaced"
		} else {
			// User chose to rename or default behavior
			newObjectKey := generateUniqueFilename(objectKey)
			log.Printf("File exists, renaming from %s to %s", objectKey, newObjectKey)
			objectKey = newObjectKey
			conflictHandled = "renamed"
		}
	}

	log.Printf("Uploading file to MinIO - Key: %s, Size: %d bytes", objectKey, handler.Size)

	// Upload to MinIO
	ctx := context.Background()
	_, err = minioClient.PutObject(ctx, bucketName, objectKey, file, handler.Size, minio.PutObjectOptions{
		ContentType: handler.Header.Get("Content-Type"),
	})
	if err != nil {
		log.Printf("Failed to upload to MinIO: %v", err)
		http.Error(w, "Failed to upload file", http.StatusInternalServerError)
		return
	}

	log.Printf("Successfully uploaded file to MinIO: %s", objectKey)

	// Return success response with conflict resolution info
	response := UploadResponse{
		Success:    true,
		Path:       "/" + objectKey,
		Message:    "File uploaded successfully",
		FileExists: fileExists,
	}

	if fileExists {
		response.OriginalName = filepath.Base(originalKey)
		response.ConflictAction = conflictHandled
		if conflictHandled == "renamed" {
			response.RenamedTo = filepath.Base(objectKey)
			response.Message = fmt.Sprintf("File renamed to %s (original already exists)", filepath.Base(objectKey))
		} else {
			response.Message = "File replaced successfully"
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

func listHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Get the path parameter
	requestPath := r.URL.Query().Get("path")
	if requestPath == "" {
		requestPath = "/"
	}

	// Clean the path
	requestPath = filepath.Clean(requestPath)

	// Remove leading slash for MinIO prefix (MinIO doesn't use leading /)
	prefix := strings.TrimPrefix(requestPath, "/")
	if prefix != "" && !strings.HasSuffix(prefix, "/") {
		prefix = prefix + "/"
	}

	log.Printf("Listing objects in MinIO - Prefix: '%s'", prefix)

	ctx := context.Background()
	objectCh := minioClient.ListObjects(ctx, bucketName, minio.ListObjectsOptions{
		Prefix:    prefix,
		Recursive: false, // Don't recurse, we want directory-like listing
	})

	// Use a map to track directories we've already added
	dirMap := make(map[string]bool)
	var files []FileInfo

	for object := range objectCh {
		if object.Err != nil {
			log.Printf("Error listing object: %v", object.Err)
			continue
		}

		// Get the relative path from the prefix
		relativePath := strings.TrimPrefix(object.Key, prefix)
		if relativePath == "" {
			continue // Skip the prefix itself
		}

		// Check if this is a directory (contains more path segments)
		parts := strings.Split(relativePath, "/")

		if len(parts) > 1 {
			// This is a nested item, represent it as a directory
			dirName := parts[0]
			if !dirMap[dirName] {
				dirMap[dirName] = true
				fullPath := "/" + prefix + dirName
				if prefix == "" {
					fullPath = "/" + dirName
				}
				files = append(files, FileInfo{
					Name:     dirName,
					Path:     fullPath,
					IsDir:    true,
					Size:     0,
					Modified: object.LastModified,
				})
			}
		} else {
			// This is a file in the current directory
			fullPath := "/" + object.Key
			files = append(files, FileInfo{
				Name:     parts[0],
				Path:     fullPath,
				IsDir:    false,
				Size:     object.Size,
				Modified: object.LastModified,
			})
		}
	}

	// Also check for objects that end with / (explicit directories)
	if prefix == "" {
		// For root, also check for any top-level prefixes
		objectCh := minioClient.ListObjects(ctx, bucketName, minio.ListObjectsOptions{
			Recursive: true,
		})

		topLevelDirs := make(map[string]bool)
		for object := range objectCh {
			if object.Err != nil {
				continue
			}
			parts := strings.Split(object.Key, "/")
			if len(parts) > 1 && parts[0] != "" {
				topLevelDirs[parts[0]] = true
			}
		}

		// Add any directories not already in our list
		for dir := range topLevelDirs {
			if !dirMap[dir] {
				files = append(files, FileInfo{
					Name:     dir,
					Path:     "/" + dir,
					IsDir:    true,
					Size:     0,
					Modified: time.Now(),
				})
			}
		}
	}

	log.Printf("Found %d items in path: %s", len(files), requestPath)

	// Return the file list as JSON
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(files); err != nil {
		log.Printf("Failed to encode response: %v", err)
		http.Error(w, "Failed to encode response", http.StatusInternalServerError)
	}
}

func downloadHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Get the file path from URL
	filePath := strings.TrimPrefix(r.URL.Path, "/api/download/")
	if filePath == "" {
		http.Error(w, "File path required", http.StatusBadRequest)
		return
	}

	// Clean the path and remove leading slash
	objectKey := strings.TrimPrefix(filepath.Clean(filePath), "/")

	log.Printf("Downloading file from MinIO: %s", objectKey)

	ctx := context.Background()
	object, err := minioClient.GetObject(ctx, bucketName, objectKey, minio.GetObjectOptions{})
	if err != nil {
		log.Printf("Failed to get object from MinIO: %v", err)
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}
	defer object.Close()

	// Get object info for headers
	stat, err := object.Stat()
	if err != nil {
		log.Printf("Failed to get object stats: %v", err)
		http.Error(w, "Failed to get file info", http.StatusInternalServerError)
		return
	}

	// Set headers for download
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", path.Base(objectKey)))
	w.Header().Set("Content-Type", stat.ContentType)
	w.Header().Set("Content-Length", fmt.Sprintf("%d", stat.Size))

	// Stream the file to the response
	written, err := io.Copy(w, object)
	if err != nil {
		log.Printf("Failed to stream file: %v", err)
		return
	}

	log.Printf("Successfully streamed %d bytes for file: %s", written, objectKey)
}

func deleteHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Get the file path from URL
	filePath := strings.TrimPrefix(r.URL.Path, "/api/delete/")
	if filePath == "" {
		http.Error(w, "File path required", http.StatusBadRequest)
		return
	}

	// Clean the path and remove leading slash
	objectKey := strings.TrimPrefix(filepath.Clean(filePath), "/")

	log.Printf("Deleting file from MinIO: %s", objectKey)

	ctx := context.Background()
	err := minioClient.RemoveObject(ctx, bucketName, objectKey, minio.RemoveObjectOptions{})
	if err != nil {
		log.Printf("Failed to delete object from MinIO: %v", err)
		http.Error(w, "Failed to delete file", http.StatusInternalServerError)
		return
	}

	log.Printf("Successfully deleted file from MinIO: %s", objectKey)

	// Return success response
	response := map[string]interface{}{
		"success": true,
		"message": "File deleted successfully",
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	// Check MinIO connectivity
	ctx := context.Background()
	_, err := minioClient.ListBuckets(ctx)

	status := map[string]interface{}{
		"status": "healthy",
		"minio":  "connected",
	}

	if err != nil {
		status["status"] = "unhealthy"
		status["minio"] = fmt.Sprintf("error: %v", err)
		w.WriteHeader(http.StatusServiceUnavailable)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(status)
}

// statsHandler returns storage statistics
func statsHandler(w http.ResponseWriter, r *http.Request) {
	ctx := context.Background()

	// Count total objects and calculate total size
	objectCh := minioClient.ListObjects(ctx, bucketName, minio.ListObjectsOptions{
		Recursive: true,
	})

	var totalObjects int64
	var totalSize int64
	var largestFile string
	var largestFileSize int64

	for object := range objectCh {
		if object.Err != nil {
			log.Printf("Error listing object for stats: %v", object.Err)
			continue
		}
		totalObjects++
		totalSize += object.Size

		if object.Size > largestFileSize {
			largestFileSize = object.Size
			largestFile = object.Key
		}
	}

	var diskInfo map[string]interface{}

	estimatedDiskUsage := int64(float64(totalSize) * 1.1) // Add 10% overhead for metadata

	// Format sizes for display
	formatBytes := func(bytes int64) string {
		const unit = 1024
		if bytes < unit {
			return fmt.Sprintf("%d B", bytes)
		}
		div, exp := int64(unit), 0
		for n := bytes / unit; n >= unit; n /= unit {
			div *= unit
			exp++
		}
		return fmt.Sprintf("%.2f %cB", float64(bytes)/float64(div), "KMGTPE"[exp])
	}

	stats := map[string]interface{}{
		"storage": map[string]interface{}{
			"totalObjects":       totalObjects,
			"totalSize":          totalSize,
			"totalSizeFormatted": formatBytes(totalSize),
			"estimatedDiskUsage": formatBytes(estimatedDiskUsage),
			"averageFileSize": formatBytes(func() int64 {
				if totalObjects > 0 {
					return totalSize / totalObjects
				}
				return 0
			}()),
		},
		"largestFile": map[string]interface{}{
			"name": largestFile,
			"size": formatBytes(largestFileSize),
		},
		"bucket":    bucketName,
		"timestamp": time.Now().Format(time.RFC3339),
	}

	// Add disk info if available
	if diskInfo != nil {
		stats["disk"] = diskInfo
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(stats)
}

func main() {
	// Initialize MinIO client
	if err := initMinIO(); err != nil {
		log.Fatalf("Failed to initialize MinIO: %v", err)
	}

	// Set up routes with CORS
	// All operations now use RClone POSIX for consistency
	http.HandleFunc("/api/upload", corsMiddleware(uploadHandlerRClone))
	http.HandleFunc("/api/list", corsMiddleware(listHandlerRClone))
	http.HandleFunc("/api/download/", corsMiddleware(downloadHandler))
	http.HandleFunc("/api/delete/", corsMiddleware(deleteHandlerRClone))
	http.HandleFunc("/api/health", corsMiddleware(healthHandler))
	http.HandleFunc("/api/stats", corsMiddleware(statsHandlerRClone))

	// Multipart upload endpoints for large files (using RClone POSIX)
	http.HandleFunc("/api/multipart/initiate", corsMiddleware(initiateMultipartHandlerRClone))
	http.HandleFunc("/api/multipart/upload-chunk", corsMiddleware(uploadChunkHandlerRClone))
	http.HandleFunc("/api/multipart/abort", corsMiddleware(abortMultipartHandlerRClone))

	// Start cleanup goroutine for expired sessions
	go cleanupOldSessions()

	// Start background stats refresh
	startBackgroundStatsRefresh()

	// Get port from environment or use default
	port := os.Getenv("SERVER_PORT")
	if port == "" {
		port = "8080"
	}

	log.Printf("Server starting on port %s...", port)
	log.Printf("MinIO endpoint: %s", os.Getenv("MINIO_ENDPOINT"))

	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatalf("Server failed to start: %v", err)
	}
}
