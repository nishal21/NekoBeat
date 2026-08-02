package gobackend

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExtensionPackageExportWrappers(t *testing.T) {
	dir := t.TempDir()
	extensionsDir := filepath.Join(dir, "extensions")
	dataDir := filepath.Join(dir, "data")
	if err := InitExtensionSystem(extensionsDir, dataDir); err != nil {
		t.Fatalf("InitExtensionSystem: %v", err)
	}
	CleanupExtensions()
	defer CleanupExtensions()

	js := `
registerExtension({
  initialize: function(settings) { this.settings = settings || {}; },
  cleanup: function() {},
  doAction: function() { return { message: "wrapped", setting_updates: { quality: "lossless" } }; },
  searchTracks: function() { return { tracks: [], total: 0 }; },
  fetchLyrics: function() { return { syncType: "UNSYNCED", lines: [{ words: "hello" }] }; },
  getDownloadUrl: function() { return { url: "https://example.test/a.flac" }; }
});
`
	pkgV1 := filepath.Join(dir, "wrapper-ext-v1.spotiflac-ext")
	pkgV2 := filepath.Join(dir, "wrapper-ext-v2.spotiflac-ext")
	createTestExtensionPackage(t, pkgV1, "wrapper-ext", "1.0.0", js, nil)
	createTestExtensionPackage(t, pkgV2, "wrapper-ext", "1.1.0", js, nil)

	loadedJSON, err := LoadExtensionFromPath(pkgV1)
	if err != nil || !strings.Contains(loadedJSON, "wrapper-ext") {
		t.Fatalf("LoadExtensionFromPath = %q/%v", loadedJSON, err)
	}
	if installedJSON, err := GetInstalledExtensions(); err != nil || !strings.Contains(installedJSON, "wrapper-ext") {
		t.Fatalf("GetInstalledExtensions = %q/%v", installedJSON, err)
	}
	if err := SetExtensionEnabledByID("wrapper-ext", true); err != nil {
		t.Fatalf("SetExtensionEnabledByID true: %v", err)
	}
	if actionJSON, err := InvokeExtensionActionJSON("wrapper-ext", "doAction"); err != nil || !strings.Contains(actionJSON, "wrapped") {
		t.Fatalf("InvokeExtensionActionJSON = %q/%v", actionJSON, err)
	}
	if upgradeJSON, err := CheckExtensionUpgradeFromPath(pkgV2); err != nil || !strings.Contains(upgradeJSON, `"can_upgrade":true`) {
		t.Fatalf("CheckExtensionUpgradeFromPath = %q/%v", upgradeJSON, err)
	}
	if upgradedJSON, err := UpgradeExtensionFromPath(pkgV2); err != nil || !strings.Contains(upgradedJSON, "1.1.0") {
		t.Fatalf("UpgradeExtensionFromPath = %q/%v", upgradedJSON, err)
	}
	if err := SetExtensionEnabledByID("wrapper-ext", false); err != nil {
		t.Fatalf("SetExtensionEnabledByID false: %v", err)
	}
	if err := UnloadExtensionByID("wrapper-ext"); err != nil {
		t.Fatalf("UnloadExtensionByID: %v", err)
	}

	dirExt := filepath.Join(extensionsDir, "wrapper-dir-ext")
	if err := createDirectoryExtension(dirExt, "wrapper-dir-ext", "1.0.0"); err != nil {
		t.Fatalf("create directory extension: %v", err)
	}
	if loadedDirJSON, err := LoadExtensionsFromDir(extensionsDir); err != nil || !strings.Contains(loadedDirJSON, "wrapper-dir-ext") {
		t.Fatalf("LoadExtensionsFromDir = %q/%v", loadedDirJSON, err)
	}
	if err := RemoveExtensionByID("wrapper-dir-ext"); err != nil {
		t.Fatalf("RemoveExtensionByID: %v", err)
	}
}

func createDirectoryExtension(dir, name, version string) error {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	manifest := fmt.Sprintf(`{"name":%q,"displayName":%q,"version":%q,"description":"Directory wrapper extension","type":["metadata_provider"],"permissions":{}}`, name, name, version)
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(manifest), 0600); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "index.js"), []byte(`registerExtension({searchTracks:function(){return {tracks:[], total:0};}});`), 0600)
}
