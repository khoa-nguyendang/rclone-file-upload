package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/minio/minio-go/v7"
)

// Storage mount path (Rclone mount)
const STORAGE_MOUNT = "/storage"

// Stats cache to avoid expensive filesystem walks
var (
	statsCacheMu       sync.RWMutex
	statsCache         map[string]interface{}
	statsCacheTime     time.Time
	statsCacheTTL      = 5 * time.Minute // Cache stats for 5 minutes
	statsCalculating   bool              // Flag to indicate if stats calculation is in progress
	statsLastDuration  time.Duration     // Last calculation duration
	statsBackgroundTicker *time.Ticker   // Background refresh ticker
)

// Rclone-based list handler using POSIX operations
func listHandlerRClone(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	requestPath := r.URL.Query().Get("path")
	if requestPath == "" {
		requestPath = "/"
	}

	fullPath := filepath.Join(STORAGE_MOUNT, requestPath)

	// Security: Ensure path doesn't escape mount point
	if !strings.HasPrefix(fullPath, STORAGE_MOUNT) {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}

	log.Printf("Listing files in storage path: %s", fullPath)

	// Read directory using standard Go filesystem operations
	entries, err := os.ReadDir(fullPath)
	if err != nil {
		log.Printf("Error reading directory: %v", err)
		http.Error(w, fmt.Sprintf("Error reading directory: %v", err), http.StatusInternalServerError)
		return
	}

	var files []FileInfo
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			log.Printf("Error getting file info for %s: %v", entry.Name(), err)
			continue
		}

		relativePath := filepath.Join(requestPath, entry.Name())
		if !strings.HasPrefix(relativePath, "/") {
			relativePath = "/" + relativePath
		}

		files = append(files, FileInfo{
			Name:     entry.Name(),
			Path:     relativePath,
			IsDir:    entry.IsDir(),
			Size:     info.Size(),
			Modified: info.ModTime(),
		})
	}

	log.Printf("Found %d items in path: %s", len(files), requestPath)

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(files); err != nil {
		log.Printf("Failed to encode response: %v", err)
		http.Error(w, "Failed to encode response", http.StatusInternalServerError)
	}
}

// Rclone-based delete handler using POSIX operations
func deleteHandlerRClone(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Get the file path from URL (e.g., /api/delete/filename)
	filePath := strings.TrimPrefix(r.URL.Path, "/api/delete/")
	if filePath == "" {
		log.Printf("Delete request missing file path")
		http.Error(w, "File path required", http.StatusBadRequest)
		return
	}

	log.Printf("Delete request - Original path: %s", filePath)

	// Clean the path - remove leading slash for filepath.Join
	filePath = strings.TrimPrefix(filePath, "/")

	// Build full path
	fullPath := filepath.Join(STORAGE_MOUNT, filePath)

	log.Printf("Delete request - Full path: %s (from: %s)", fullPath, filePath)

	// Security: Ensure path doesn't escape mount point
	if !strings.HasPrefix(fullPath, STORAGE_MOUNT) {
		log.Printf("Security error: path %s escapes mount point %s", fullPath, STORAGE_MOUNT)
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}

	// Check if path exists
	info, err := os.Stat(fullPath)
	if err != nil {
		if os.IsNotExist(err) {
			log.Printf("File not found: %s (checked at: %s)", filePath, fullPath)
			// List directory contents for debugging
			dir := filepath.Dir(fullPath)
			if entries, readErr := os.ReadDir(dir); readErr == nil {
				log.Printf("Directory %s contents:", dir)
				for _, entry := range entries {
					log.Printf("  - %s", entry.Name())
				}
			}
			http.Error(w, fmt.Sprintf("File not found: %s", filePath), http.StatusNotFound)
			return
		}
		log.Printf("Error accessing file %s: %v", fullPath, err)
		http.Error(w, fmt.Sprintf("Error accessing file: %v", err), http.StatusInternalServerError)
		return
	}

	// Delete file or directory
	if info.IsDir() {
		err = os.RemoveAll(fullPath)
	} else {
		err = os.Remove(fullPath)
	}

	if err != nil {
		log.Printf("Error deleting: %v", err)
		http.Error(w, fmt.Sprintf("Error deleting: %v", err), http.StatusInternalServerError)
		return
	}

	log.Printf("Successfully deleted from RClone: %s", filePath)

	response := map[string]interface{}{
		"success": true,
		"message": "File deleted successfully",
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// RClone-based stats handler using MinIO API (FAST!)
// Note: Using MinIO API directly instead of POSIX walk for better performance
func statsHandlerRClone(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Check for force refresh parameter
	forceRefresh := r.URL.Query().Get("refresh") == "true"

	// Try to use cached stats first
	statsCacheMu.RLock()
	cachedStats := statsCache
	cacheTime := statsCacheTime
	isCalculating := statsCalculating
	statsCacheMu.RUnlock()

	// If cache exists and is fresh, return it
	if !forceRefresh && cachedStats != nil && time.Since(cacheTime) < statsCacheTTL {
		log.Printf("Serving cached stats (age: %v)", time.Since(cacheTime))

		// Update cache age in the response
		cachedStats["cacheAge"] = time.Since(cacheTime).String()

		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Cache-Hit", "true")
		json.NewEncoder(w).Encode(cachedStats)
		return
	}

	// If calculation already in progress in background, return stale cache if available
	if isCalculating && cachedStats != nil {
		log.Printf("Calculation in progress, returning stale cache")
		cachedStats["calculatingInBackground"] = true
		cachedStats["cacheAge"] = time.Since(cacheTime).String()

		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Cache-Stale", "true")
		json.NewEncoder(w).Encode(cachedStats)
		return
	}

	log.Printf("Calculating fresh stats using MinIO API")

	// Set calculating flag
	statsCacheMu.Lock()
	statsCalculating = true
	statsCacheMu.Unlock()

	startTime := time.Now()
	ctx := context.Background()

	var totalObjects int64
	var totalSize int64
	var largestFile string
	var largestFileSize int64
	var walkDuration time.Duration

	// Try to use Admin API (DataUsageInfo) first - FASTEST!
	if madminClient != nil {
		log.Printf("Attempting to use MinIO Admin API (DataUsageInfo) for instant stats")
		dataUsage, err := madminClient.DataUsageInfo(ctx)
		if err == nil && dataUsage.BucketsUsage != nil {
			if bucketUsage, exists := dataUsage.BucketsUsage[bucketName]; exists {
				totalObjects = int64(bucketUsage.ObjectsCount)
				totalSize = int64(bucketUsage.Size)

				walkDuration = time.Since(startTime)
				log.Printf("Stats retrieved in %v using Admin API - Objects: %d, Total Size: %d bytes",
					walkDuration, totalObjects, totalSize)

				// Note: Admin API doesn't provide largest file info easily
				// We'll skip it for performance
				largestFile = "N/A (Admin API used for speed)"
				largestFileSize = 0
			} else {
				log.Printf("Bucket %s not found in DataUsageInfo, falling back to ListObjects", bucketName)
			}
		} else {
			log.Printf("Admin API call failed: %v, falling back to ListObjects", err)
		}
	}

	// If Admin API didn't work or wasn't available, use ListObjects
	if totalObjects == 0 && totalSize == 0 {
		log.Printf("Using MinIO ListObjects API")
		objectCh := minioClient.ListObjects(ctx, bucketName, minio.ListObjectsOptions{
			Recursive: true,
		})

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

		walkDuration = time.Since(startTime)
		log.Printf("Stats calculated in %v using ListObjects API - Objects: %d, Total Size: %d bytes", walkDuration, totalObjects, totalSize)
	}

	// Store last calculation duration
	statsCacheMu.Lock()
	statsLastDuration = walkDuration
	statsCalculating = false
	statsCacheMu.Unlock()

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

	estimatedDiskUsage := int64(float64(totalSize) * 1.1) // Add 10% overhead

	// Get bucket name from environment or use default
	bucket := os.Getenv("STORAGE_BUCKET")
	if bucket == "" {
		bucket = bucketName // fallback to global variable
	}

	// Prepare largest file info
	largestFileName := largestFile
	if largestFileName == "" {
		largestFileName = "N/A"
	}

	// Calculate cache age
	cacheAge := time.Since(statsCacheTime)
	if statsCache == nil {
		cacheAge = 0
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
			"name": largestFileName,
			"size": formatBytes(largestFileSize),
		},
		"bucket":            bucket,
		"timestamp":         time.Now().Format(time.RFC3339),
		"mountPath":         STORAGE_MOUNT,
		"cacheEnabled":      true,
		"cacheTTL":          statsCacheTTL.String(),
		"calculationTime":   walkDuration.String(),
		"cacheAge":          cacheAge.String(),
		"calculatingInBackground": false,
	}

	// Update cache
	statsCacheMu.Lock()
	statsCache = stats
	statsCacheTime = time.Now()
	statsCacheMu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Cache-Hit", "false")
	if err := json.NewEncoder(w).Encode(stats); err != nil {
		log.Printf("Error encoding stats response: %v", err)
	}

	log.Printf("Stats response sent successfully (calculated in %v, cached for %v)", walkDuration, statsCacheTTL)
}

// Background stats calculation - runs periodically to keep cache fresh
func calculateStatsInBackground() {
	statsCacheMu.Lock()
	if statsCalculating {
		statsCacheMu.Unlock()
		log.Printf("Stats calculation already in progress, skipping background refresh")
		return
	}
	statsCalculating = true
	statsCacheMu.Unlock()

	log.Printf("Starting background stats calculation")
	startTime := time.Now()
	ctx := context.Background()

	var totalObjects int64
	var totalSize int64
	var largestFile string
	var largestFileSize int64
	var duration time.Duration

	// Try to use Admin API (DataUsageInfo) first - FASTEST!
	if madminClient != nil {
		dataUsage, err := madminClient.DataUsageInfo(ctx)
		if err == nil && dataUsage.BucketsUsage != nil {
			if bucketUsage, exists := dataUsage.BucketsUsage[bucketName]; exists {
				totalObjects = int64(bucketUsage.ObjectsCount)
				totalSize = int64(bucketUsage.Size)
				duration = time.Since(startTime)
				largestFile = "N/A (Admin API used)"
				largestFileSize = 0

				log.Printf("Background stats retrieved in %v using Admin API - Objects: %d, Total Size: %d bytes",
					duration, totalObjects, totalSize)
			}
		}
	}

	// Fallback to ListObjects if Admin API didn't work
	if totalObjects == 0 && totalSize == 0 {
		objectCh := minioClient.ListObjects(ctx, bucketName, minio.ListObjectsOptions{
			Recursive: true,
		})

		for object := range objectCh {
			if object.Err != nil {
				log.Printf("Error listing object for background stats: %v", object.Err)
				continue
			}
			totalObjects++
			totalSize += object.Size

			if object.Size > largestFileSize {
				largestFileSize = object.Size
				largestFile = object.Key
			}
		}

		duration = time.Since(startTime)
		log.Printf("Background stats calculated in %v using ListObjects - Objects: %d, Total Size: %d bytes", duration, totalObjects, totalSize)
	}

	// Format sizes
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

	estimatedDiskUsage := int64(float64(totalSize) * 1.1)
	bucket := os.Getenv("STORAGE_BUCKET")
	if bucket == "" {
		bucket = bucketName
	}

	largestFileName := largestFile
	if largestFileName == "" {
		largestFileName = "N/A"
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
			"name": largestFileName,
			"size": formatBytes(largestFileSize),
		},
		"bucket":                  bucket,
		"timestamp":               time.Now().Format(time.RFC3339),
		"mountPath":               STORAGE_MOUNT,
		"cacheEnabled":            true,
		"cacheTTL":                statsCacheTTL.String(),
		"calculationTime":         duration.String(),
		"cacheAge":                "0s",
		"calculatingInBackground": false,
	}

	// Update cache
	statsCacheMu.Lock()
	statsCache = stats
	statsCacheTime = time.Now()
	statsLastDuration = duration
	statsCalculating = false
	statsCacheMu.Unlock()

	log.Printf("Background stats cache updated successfully")
}

// Start background stats refresh - called once on server startup
func startBackgroundStatsRefresh() {
	// Initial calculation
	go calculateStatsInBackground()

	// Periodic refresh every 5 minutes
	statsBackgroundTicker = time.NewTicker(5 * time.Minute)
	go func() {
		for range statsBackgroundTicker.C {
			calculateStatsInBackground()
		}
	}()

	log.Printf("Background stats refresh started (every 5 minutes)")
}
