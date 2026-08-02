package gobackend

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dop251/goja"
)

func TestExtensionFileReadLengthRequiresChunking(t *testing.T) {
	if _, err := extensionFileReadLength(maxExtensionFileReadBytes+1, 0, -1); err == nil {
		t.Fatal("unbounded large read was accepted")
	}
	if _, err := extensionFileReadLength(maxExtensionFileReadBytes+1, 0, maxExtensionFileReadBytes+1); err == nil {
		t.Fatal("oversized explicit read was accepted")
	}
	if got, err := extensionFileReadLength(maxExtensionFileReadBytes+1, maxExtensionFileReadBytes, -1); err != nil || got != 1 {
		t.Fatalf("tail read length = %d, %v", got, err)
	}
	if got, err := extensionFileReadLength(5, 2, 10); err != nil || got != 3 {
		t.Fatalf("clamped read length = %d, %v", got, err)
	}
}

func TestExtensionFileAPIsRejectUnboundedLargeReads(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "large.bin")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(maxExtensionFileReadBytes + 1); err != nil {
		file.Close()
		t.Fatal(err)
	}
	file.Close()

	vm := goja.New()
	runtime := &extensionRuntime{
		vm:       vm,
		dataDir:  dir,
		manifest: &ExtensionManifest{Permissions: ExtensionPermissions{File: true}},
	}

	readResult := runtime.fileRead(goja.FunctionCall{Arguments: []goja.Value{vm.ToValue("large.bin")}}).Export().(map[string]any)
	if readResult["success"] != false || !strings.Contains(readResult["error"].(string), "chunks") {
		t.Fatalf("fileRead result = %#v", readResult)
	}

	readBytesResult := runtime.fileReadBytes(goja.FunctionCall{Arguments: []goja.Value{vm.ToValue("large.bin")}}).Export().(map[string]any)
	if readBytesResult["success"] != false || !strings.Contains(readBytesResult["error"].(string), "chunks") {
		t.Fatalf("fileReadBytes result = %#v", readBytesResult)
	}
}
