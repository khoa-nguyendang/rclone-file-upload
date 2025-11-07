package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/google/uuid"
)

// ChunkUploadSessionRClone stores information about ongoing chunked uploads to RClone
type ChunkUploadSessionRClone struct {
	SessionID     string
	FileName      string
	FilePath      string   // Path in RClone where file will be written
	TempFile      *os.File // Temporary file being assembled
	TotalParts    int
	ReceivedParts map[int]bool
	mu            sync.Mutex
}

var uploadSessionsRClone = make(map[string]*ChunkUploadSessionRClone)
var sessionsRCloneMu sync.RWMutex

// Initiate multipart upload for RClone
func initiateMultipartHandlerRClone(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req InitiateMultipartRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	// Generate session ID
	sessionID := uuid.New().String()

	// Determine target path in RClone
	uploadPath := req.Path
	if uploadPath == "" {
		uploadPath = "/"
	}

	var targetPath string
	if uploadPath == "/" || uploadPath == "" {
		targetPath = filepath.Join(STORAGE_MOUNT, req.FileName)
	} else {
		uploadPath = strings.TrimPrefix(filepath.Clean(uploadPath), "/")
		targetPath = filepath.Join(STORAGE_MOUNT, uploadPath, req.FileName)
	}

	// Create directory if needed
	targetDir := filepath.Dir(targetPath)
	if err := os.MkdirAll(targetDir, 0755); err != nil {
		log.Printf("Failed to create directory: %v", err)
		http.Error(w, "Failed to create directory", http.StatusInternalServerError)
		return
	}

	// Create temporary file for assembling chunks
	tempFile, err := os.CreateTemp(os.TempDir(), "rclone-upload-*")
	if err != nil {
		log.Printf("Failed to create temp file: %v", err)
		http.Error(w, "Failed to create temp file", http.StatusInternalServerError)
		return
	}

	// Create session
	session := &ChunkUploadSessionRClone{
		SessionID:     sessionID,
		FileName:      req.FileName,
		FilePath:      targetPath,
		TempFile:      tempFile,
		TotalParts:    req.TotalParts,
		ReceivedParts: make(map[int]bool),
	}

	sessionsRCloneMu.Lock()
	uploadSessionsRClone[sessionID] = session
	sessionsRCloneMu.Unlock()

	log.Printf("Initiated RClone chunked upload - Session: %s, File: %s, Parts: %d",
		sessionID, req.FileName, req.TotalParts)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(MultipartResponse{
		Success:   true,
		SessionID: sessionID,
		Message:   "Upload session created",
	})
}

// Upload chunk for RClone
func uploadChunkHandlerRClone(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Parse multipart form
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
	sessionsRCloneMu.RLock()
	session, exists := uploadSessionsRClone[sessionID]
	sessionsRCloneMu.RUnlock()

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

	chunkSize := header.Size
	log.Printf("Receiving chunk %d for session %s, size: %d bytes", partNumber, sessionID, chunkSize)

	// Write chunk to temp file
	// For simplicity, we append chunks sequentially
	// In production, you might want to handle out-of-order chunks
	session.mu.Lock()
	_, err = io.Copy(session.TempFile, file)
	session.ReceivedParts[partNumber] = true
	receivedCount := len(session.ReceivedParts)
	session.mu.Unlock()

	if err != nil {
		log.Printf("Failed to write chunk: %v", err)
		http.Error(w, "Failed to write chunk", http.StatusInternalServerError)
		return
	}

	progress := float64(receivedCount) / float64(session.TotalParts) * 100
	log.Printf("Chunk %d/%d received, Progress: %.1f%%", receivedCount, session.TotalParts, progress)

	// If all parts received, finalize the upload
	if receivedCount == session.TotalParts {
		if err := finalizeRCloneUpload(session); err != nil {
			log.Printf("Failed to finalize upload: %v", err)
			http.Error(w, "Failed to finalize upload", http.StatusInternalServerError)
			return
		}

		// Clean up session
		sessionsRCloneMu.Lock()
		delete(uploadSessionsRClone, sessionID)
		sessionsRCloneMu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(MultipartResponse{
			Success:  true,
			Message:  "Upload completed successfully",
			Progress: 100,
		})
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

// Finalize RClone upload by moving temp file to final location
func finalizeRCloneUpload(session *ChunkUploadSessionRClone) error {
	// Close temp file
	if err := session.TempFile.Close(); err != nil {
		return fmt.Errorf("failed to close temp file: %w", err)
	}

	// Move temp file to final location in RClone
	if err := os.Rename(session.TempFile.Name(), session.FilePath); err != nil {
		// If rename fails (cross-device), copy the file
		return copyFile(session.TempFile.Name(), session.FilePath)
	}

	log.Printf("Finalized RClone upload: %s", session.FilePath)
	return nil
}

// Copy file helper (for cross-device moves)
func copyFile(src, dst string) error {
	sourceFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer sourceFile.Close()

	destFile, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer destFile.Close()

	if _, err := io.Copy(destFile, sourceFile); err != nil {
		return err
	}

	// Remove source file
	return os.Remove(src)
}

// Abort multipart upload for RClone
func abortMultipartHandlerRClone(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	sessionID := r.URL.Query().Get("session_id")
	if sessionID == "" {
		http.Error(w, "Session ID required", http.StatusBadRequest)
		return
	}

	sessionsRCloneMu.Lock()
	session, exists := uploadSessionsRClone[sessionID]
	if exists {
		// Close and remove temp file
		session.TempFile.Close()
		os.Remove(session.TempFile.Name())
		delete(uploadSessionsRClone, sessionID)
	}
	sessionsRCloneMu.Unlock()

	if !exists {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}

	log.Printf("Aborted upload session: %s", sessionID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(MultipartResponse{
		Success: true,
		Message: "Upload aborted",
	})
}
