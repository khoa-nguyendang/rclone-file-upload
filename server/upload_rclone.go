package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
)

// Upload handler using RClone POSIX operations
func uploadHandlerRClone(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Parse multipart form
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

	// Get conflict resolution strategy
	conflictAction := r.FormValue("conflictAction")
	if conflictAction == "" {
		conflictAction = "rename"
	}

	// Construct full path in RClone
	var targetPath string
	if uploadPath == "/" || uploadPath == "" {
		targetPath = filepath.Join(STORAGE_MOUNT, handler.Filename)
	} else {
		// Clean the path and ensure it's relative
		uploadPath = strings.TrimPrefix(filepath.Clean(uploadPath), "/")
		targetPath = filepath.Join(STORAGE_MOUNT, uploadPath, handler.Filename)
	}

	// Ensure directory exists
	targetDir := filepath.Dir(targetPath)
	if err := os.MkdirAll(targetDir, 0755); err != nil {
		log.Printf("Failed to create directory: %v", err)
		http.Error(w, "Failed to create directory", http.StatusInternalServerError)
		return
	}

	// Check if file exists and handle conflict
	originalPath := targetPath
	fileExists := false
	if _, err := os.Stat(targetPath); err == nil {
		fileExists = true
		if conflictAction == "replace" {
			// Remove existing file
			log.Printf("File exists, replacing: %s", targetPath)
		} else {
			// Generate unique filename
			ext := filepath.Ext(handler.Filename)
			nameWithoutExt := strings.TrimSuffix(handler.Filename, ext)
			shortUUID := uuid.New().String()[:8]
			newFilename := fmt.Sprintf("%s_%s%s", nameWithoutExt, shortUUID, ext)
			targetPath = filepath.Join(targetDir, newFilename)
			log.Printf("File exists, renaming to: %s", targetPath)
		}
	}

	// Create the file in RClone
	outFile, err := os.Create(targetPath)
	if err != nil {
		log.Printf("Failed to create file in RClone: %v", err)
		http.Error(w, "Failed to create file", http.StatusInternalServerError)
		return
	}
	defer outFile.Close()

	// Copy data to RClone file
	written, err := io.Copy(outFile, file)
	if err != nil {
		log.Printf("Failed to write file to RClone: %v", err)
		http.Error(w, "Failed to write file", http.StatusInternalServerError)
		return
	}

	// Get relative path for response
	relativePath := strings.TrimPrefix(targetPath, STORAGE_MOUNT)
	if !strings.HasPrefix(relativePath, "/") {
		relativePath = "/" + relativePath
	}

	log.Printf("Successfully uploaded file to RClone: %s (%d bytes)", relativePath, written)

	// Invalidate stats cache after successful upload
	InvalidateStatsCache()

	// Return success response
	response := UploadResponse{
		Success:    true,
		Path:       relativePath,
		Message:    "File uploaded successfully",
		FileExists: fileExists,
	}

	if fileExists {
		response.OriginalName = filepath.Base(originalPath)
		if conflictAction == "rename" {
			response.ConflictAction = "renamed"
			response.RenamedTo = filepath.Base(targetPath)
			response.Message = fmt.Sprintf("File renamed to %s (original already exists)", filepath.Base(targetPath))
		} else {
			response.ConflictAction = "replaced"
			response.Message = "File replaced successfully"
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}
