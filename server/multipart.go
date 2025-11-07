package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"
)

// ChunkUploadSession stores information about ongoing multipart uploads
type ChunkUploadSession struct {
	UploadID    string
	FileName    string
	TotalParts  int
	UploadedParts map[int]minio.CompletePart
	StartTime   time.Time
	mu          sync.Mutex
}

// Global session storage (in production, use Redis or database)
var uploadSessions = make(map[string]*ChunkUploadSession)
var sessionsMu sync.RWMutex

// InitiateMultipartRequest for starting chunked upload
type InitiateMultipartRequest struct {
	FileName   string `json:"filename"`
	TotalParts int    `json:"total_parts"`
	FileSize   int64  `json:"file_size"`
	Path       string `json:"path,omitempty"`
}

// ChunkUploadRequest for uploading individual chunks
type ChunkUploadRequest struct {
	SessionID  string `json:"session_id"`
	PartNumber int    `json:"part_number"`
	TotalParts int    `json:"total_parts"`
}

// MultipartResponse for all multipart operations
type MultipartResponse struct {
	Success    bool   `json:"success"`
	SessionID  string `json:"session_id,omitempty"`
	UploadID   string `json:"upload_id,omitempty"`
	PartNumber int    `json:"part_number,omitempty"`
	Message    string `json:"message"`
	Progress   float64 `json:"progress,omitempty"`
}

// initiateMultipartHandler starts a new multipart upload session
func initiateMultipartHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req InitiateMultipartRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	// Generate object key
	uploadPath := req.Path
	if uploadPath == "" {
		uploadPath = "/"
	}

	var objectKey string
	if uploadPath == "/" || uploadPath == "" {
		objectKey = req.FileName
	} else {
		uploadPath = strings.TrimPrefix(filepath.Clean(uploadPath), "/")
		objectKey = path.Join(uploadPath, req.FileName)
	}
	objectKey = strings.TrimPrefix(objectKey, "/")

	// Initiate multipart upload in MinIO using Core client
	ctx := context.Background()
	uploadID, err := coreClient.NewMultipartUpload(ctx, bucketName, objectKey, minio.PutObjectOptions{
		ContentType: "application/octet-stream",
	})
	if err != nil {
		log.Printf("Failed to initiate multipart upload: %v", err)
		http.Error(w, "Failed to initiate upload", http.StatusInternalServerError)
		return
	}

	// Create session
	sessionID := uuid.New().String()
	session := &ChunkUploadSession{
		UploadID:      uploadID,
		FileName:      objectKey,
		TotalParts:    req.TotalParts,
		UploadedParts: make(map[int]minio.CompletePart),
		StartTime:     time.Now(),
	}

	sessionsMu.Lock()
	uploadSessions[sessionID] = session
	sessionsMu.Unlock()

	log.Printf("Initiated multipart upload - Session: %s, UploadID: %s, File: %s, Parts: %d",
		sessionID, uploadID, objectKey, req.TotalParts)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(MultipartResponse{
		Success:   true,
		SessionID: sessionID,
		UploadID:  uploadID,
		Message:   "Multipart upload initiated",
	})
}

// uploadChunkHandler handles individual chunk uploads
func uploadChunkHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Parse multipart form with 100MB max memory
	if err := r.ParseMultipartForm(100 << 20); err != nil {
		http.Error(w, "Failed to parse form", http.StatusBadRequest)
		return
	}

	sessionID := r.FormValue("session_id")
	partNumberStr := r.FormValue("part_number")

	partNumber, err := strconv.Atoi(partNumberStr)
	if err != nil {
		http.Error(w, "Invalid part number", http.StatusBadRequest)
		return
	}

	// Get session
	sessionsMu.RLock()
	session, exists := uploadSessions[sessionID]
	sessionsMu.RUnlock()

	if !exists {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}

	// Get chunk file
	file, header, err := r.FormFile("chunk")
	if err != nil {
		http.Error(w, "Failed to get chunk file", http.StatusBadRequest)
		return
	}
	defer file.Close()

	// Get chunk size from the file header
	chunkSize := header.Size
	log.Printf("Uploading part %d with size: %d bytes", partNumber, chunkSize)

	// Upload part to MinIO using Core client
	ctx := context.Background()
	objectPart, err := coreClient.PutObjectPart(ctx, bucketName, session.FileName, session.UploadID,
		partNumber, file, chunkSize, minio.PutObjectPartOptions{})
	if err != nil {
		log.Printf("Failed to upload part %d: %v", partNumber, err)
		http.Error(w, "Failed to upload chunk", http.StatusInternalServerError)
		return
	}

	// Store part info as CompletePart
	session.mu.Lock()
	session.UploadedParts[partNumber] = minio.CompletePart{
		PartNumber: partNumber,
		ETag:       objectPart.ETag,
	}
	uploadedCount := len(session.UploadedParts)
	session.mu.Unlock()

	progress := float64(uploadedCount) / float64(session.TotalParts) * 100

	log.Printf("Uploaded chunk - Session: %s, Part: %d/%d, Progress: %.1f%%",
		sessionID, partNumber, session.TotalParts, progress)

	// If all parts uploaded, complete the upload
	if uploadedCount == session.TotalParts {
		completeMultipartUpload(sessionID, session, w)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(MultipartResponse{
		Success:    true,
		SessionID:  sessionID,
		PartNumber: partNumber,
		Progress:   progress,
		Message:    fmt.Sprintf("Chunk %d uploaded successfully", partNumber),
	})
}

// completeMultipartUpload finishes the multipart upload
func completeMultipartUpload(sessionID string, session *ChunkUploadSession, w http.ResponseWriter) {
	// Prepare parts list
	var parts []minio.CompletePart
	for i := 1; i <= session.TotalParts; i++ {
		if part, ok := session.UploadedParts[i]; ok {
			parts = append(parts, part)
		}
	}

	// Complete multipart upload using Core client
	ctx := context.Background()
	_, err := coreClient.CompleteMultipartUpload(ctx, bucketName, session.FileName,
		session.UploadID, parts, minio.PutObjectOptions{})
	if err != nil {
		log.Printf("Failed to complete multipart upload: %v", err)
		http.Error(w, "Failed to complete upload", http.StatusInternalServerError)
		return
	}

	// Clean up session
	sessionsMu.Lock()
	delete(uploadSessions, sessionID)
	sessionsMu.Unlock()

	duration := time.Since(session.StartTime)
	log.Printf("Completed multipart upload - Session: %s, File: %s, Duration: %v",
		sessionID, session.FileName, duration)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(MultipartResponse{
		Success:  true,
		SessionID: sessionID,
		Progress: 100,
		Message:  fmt.Sprintf("Upload completed in %v", duration.Round(time.Second)),
	})
}

// abortMultipartHandler cancels an ongoing multipart upload
func abortMultipartHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	sessionID := r.URL.Query().Get("session_id")
	if sessionID == "" {
		http.Error(w, "Session ID required", http.StatusBadRequest)
		return
	}

	sessionsMu.Lock()
	session, exists := uploadSessions[sessionID]
	if exists {
		delete(uploadSessions, sessionID)
	}
	sessionsMu.Unlock()

	if !exists {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}

	// Abort multipart upload in MinIO using Core client
	ctx := context.Background()
	err := coreClient.AbortMultipartUpload(ctx, bucketName, session.FileName, session.UploadID)
	if err != nil {
		log.Printf("Failed to abort multipart upload: %v", err)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "Upload aborted",
	})
}

// getPresignedUploadURL generates a presigned URL for direct upload to S3
func getPresignedUploadURLHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		FileName string `json:"filename"`
		Path     string `json:"path,omitempty"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	// Generate object key
	uploadPath := req.Path
	if uploadPath == "" {
		uploadPath = "/"
	}

	var objectKey string
	if uploadPath == "/" || uploadPath == "" {
		objectKey = req.FileName
	} else {
		uploadPath = strings.TrimPrefix(filepath.Clean(uploadPath), "/")
		objectKey = path.Join(uploadPath, req.FileName)
	}
	objectKey = strings.TrimPrefix(objectKey, "/")

	// Generate presigned URL (valid for 24 hours)
	ctx := context.Background()
	presignedURL, err := minioClient.PresignedPutObject(ctx, bucketName, objectKey, 24*time.Hour)
	if err != nil {
		log.Printf("Failed to generate presigned URL: %v", err)
		http.Error(w, "Failed to generate upload URL", http.StatusInternalServerError)
		return
	}

	log.Printf("Generated presigned URL for: %s", objectKey)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":    true,
		"upload_url": presignedURL.String(),
		"object_key": objectKey,
		"expires_in": "24h",
		"message":    "Use this URL to upload directly to storage",
	})
}

// cleanupOldSessions removes expired upload sessions (run periodically)
func cleanupOldSessions() {
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()

	for range ticker.C {
		sessionsMu.Lock()
		for id, session := range uploadSessions {
			// Remove sessions older than 24 hours
			if time.Since(session.StartTime) > 24*time.Hour {
				// Abort the multipart upload in MinIO using Core client
				ctx := context.Background()
				coreClient.AbortMultipartUpload(ctx, bucketName, session.FileName, session.UploadID)
				delete(uploadSessions, id)
				log.Printf("Cleaned up expired session: %s", id)
			}
		}
		sessionsMu.Unlock()
	}
}