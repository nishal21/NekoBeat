package gobackend

import (
	"strings"
	"sync"
)

var providerPriority []string
var providerPriorityMu sync.RWMutex

var extensionFallbackProviderIDs []string
var extensionFallbackProviderIDsMu sync.RWMutex

var metadataProviderPriority []string
var metadataProviderPriorityMu sync.RWMutex

func SetProviderPriority(providerIDs []string) {
	providerPriorityMu.Lock()
	defer providerPriorityMu.Unlock()
	providerPriority = sanitizeDownloadProviderPriority(providerIDs)
	GoLog("[Extension] Download provider priority set: %v\n", providerPriority)
}

func GetProviderPriority() []string {
	providerPriorityMu.RLock()
	defer providerPriorityMu.RUnlock()

	if len(providerPriority) == 0 {
		return []string{}
	}

	result := make([]string, len(providerPriority))
	copy(result, providerPriority)
	return result
}

func sanitizeDownloadProviderPriority(providerIDs []string) []string {
	sanitized := make([]string, 0, len(providerIDs))
	seen := map[string]struct{}{}

	for _, providerID := range providerIDs {
		providerID = strings.TrimSpace(providerID)
		if providerID == "" {
			continue
		}

		if isRetiredBuiltInDownloadProvider(providerID) {
			continue
		}

		seenKey := strings.ToLower(providerID)
		if _, exists := seen[seenKey]; exists {
			continue
		}
		seen[seenKey] = struct{}{}
		sanitized = append(sanitized, providerID)
	}

	return sanitized
}

func isRetiredBuiltInDownloadProvider(providerID string) bool {
	normalized := strings.ToLower(strings.TrimSpace(providerID))
	if normalized == "" {
		return false
	}
	switch normalized {
	case "deezer", "qobuz", "tidal":
		return !hasEnabledExtensionProvider(normalized, func(manifest *ExtensionManifest) bool {
			return manifest.IsDownloadProvider()
		})
	default:
		return false
	}
}

func isRetiredBuiltInMetadataProvider(providerID string) bool {
	normalized := strings.ToLower(strings.TrimSpace(providerID))
	if normalized == "" {
		return false
	}
	switch normalized {
	case "deezer", "spotify", "qobuz", "tidal":
		return !hasEnabledExtensionProvider(normalized, func(manifest *ExtensionManifest) bool {
			return manifest.IsMetadataProvider()
		})
	default:
		return false
	}
}

func hasEnabledExtensionProvider(providerID string, matches func(*ExtensionManifest) bool) bool {
	if providerID == "" || matches == nil {
		return false
	}

	manager := getExtensionManager()
	manager.mu.RLock()
	defer manager.mu.RUnlock()

	for id, ext := range manager.extensions {
		if !strings.EqualFold(strings.TrimSpace(id), providerID) {
			continue
		}
		if ext == nil || !ext.Enabled || ext.Error != "" || ext.Manifest == nil {
			return false
		}
		return matches(ext.Manifest)
	}

	return false
}

func SetExtensionFallbackProviderIDs(providerIDs []string) {
	extensionFallbackProviderIDsMu.Lock()
	defer extensionFallbackProviderIDsMu.Unlock()

	if providerIDs == nil {
		extensionFallbackProviderIDs = nil
		GoLog("[Extension] Extension fallback providers reset to default (all enabled download extensions)\n")
		return
	}

	sanitized := make([]string, 0, len(providerIDs))
	seen := map[string]struct{}{}
	for _, providerID := range providerIDs {
		providerID = strings.TrimSpace(providerID)
		if providerID == "" {
			continue
		}
		if _, exists := seen[providerID]; exists {
			continue
		}
		seen[providerID] = struct{}{}
		sanitized = append(sanitized, providerID)
	}

	extensionFallbackProviderIDs = sanitized
	GoLog("[Extension] Extension fallback providers set: %v\n", sanitized)
}

func GetExtensionFallbackProviderIDs() []string {
	extensionFallbackProviderIDsMu.RLock()
	defer extensionFallbackProviderIDsMu.RUnlock()

	if extensionFallbackProviderIDs == nil {
		return nil
	}

	result := make([]string, len(extensionFallbackProviderIDs))
	copy(result, extensionFallbackProviderIDs)
	return result
}

func isExtensionFallbackAllowed(providerID string) bool {
	allowed := GetExtensionFallbackProviderIDs()
	if allowed == nil {
		return true
	}

	for _, allowedProviderID := range allowed {
		if allowedProviderID == providerID {
			return true
		}
	}
	return false
}

func SetMetadataProviderPriority(providerIDs []string) {
	metadataProviderPriorityMu.Lock()
	defer metadataProviderPriorityMu.Unlock()

	sanitized := make([]string, 0, len(providerIDs))
	seen := map[string]struct{}{}
	for _, providerID := range providerIDs {
		providerID = strings.TrimSpace(providerID)
		if providerID == "" || isRetiredBuiltInMetadataProvider(providerID) {
			continue
		}
		if _, exists := seen[providerID]; exists {
			continue
		}
		seen[providerID] = struct{}{}
		sanitized = append(sanitized, providerID)
	}
	metadataProviderPriority = sanitized
	GoLog("[Extension] Metadata provider priority set: %v\n", sanitized)
}

func GetMetadataProviderPriority() []string {
	metadataProviderPriorityMu.RLock()
	defer metadataProviderPriorityMu.RUnlock()

	if len(metadataProviderPriority) == 0 {
		return []string{}
	}

	result := make([]string, len(metadataProviderPriority))
	copy(result, metadataProviderPriority)
	return result
}
