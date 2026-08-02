package gobackend

func SetLibraryCoverCacheDirJSON(cacheDir string) {
	SetLibraryCoverCacheDir(cacheDir)
}

func ScanLibraryFolderJSON(folderPath string) (string, error) {
	return ScanLibraryFolder(folderPath)
}

func ScanLibraryFolderIncrementalJSON(folderPath, existingFilesJSON string) (string, error) {
	return ScanLibraryFolderIncremental(folderPath, existingFilesJSON)
}

func ScanLibraryFolderIncrementalFromSnapshotJSON(folderPath, snapshotPath string) (string, error) {
	return ScanLibraryFolderIncrementalFromSnapshot(folderPath, snapshotPath)
}

func GetLibraryScanProgressJSON() string {
	return GetLibraryScanProgress()
}

func CancelLibraryScanJSON() {
	CancelLibraryScan()
}

func ReadAudioMetadataJSON(filePath string) (string, error) {
	return ReadAudioMetadata(filePath)
}

func ReadAudioMetadataWithHintAndCoverCacheKeyJSON(filePath, displayName, coverCacheKey string) (string, error) {
	return ReadAudioMetadataWithDisplayNameAndCoverCacheKey(filePath, displayName, coverCacheKey)
}
