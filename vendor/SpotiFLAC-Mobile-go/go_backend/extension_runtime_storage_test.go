package gobackend

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dop251/goja"
)

func setStorageValue(t *testing.T, runtime *extensionRuntime, key string, value any) {
	t.Helper()
	result := runtime.storageSet(goja.FunctionCall{
		Arguments: []goja.Value{
			runtime.vm.ToValue(key),
			runtime.vm.ToValue(value),
		},
	})
	if !result.ToBoolean() {
		t.Fatalf("storage.set(%q) returned false", key)
	}
}

func TestExtensionRuntimeStorageConcurrentRuntimesMergeWrites(t *testing.T) {
	dataDir := t.TempDir()
	ext := &loadedExtension{ID: "merge-test", Manifest: &ExtensionManifest{Name: "merge-test"}, DataDir: dataDir}
	runtimeA := newExtensionRuntime(ext)
	runtimeB := newExtensionRuntime(ext)
	runtimeA.RegisterAPIs(goja.New())
	runtimeB.RegisterAPIs(goja.New())

	start := make(chan struct{})
	done := make(chan bool, 2)
	go func() {
		<-start
		result := runtimeA.storageSet(goja.FunctionCall{Arguments: []goja.Value{
			runtimeA.vm.ToValue("from_a"), runtimeA.vm.ToValue("a"),
		}})
		done <- result.ToBoolean()
	}()
	go func() {
		<-start
		result := runtimeB.storageSet(goja.FunctionCall{Arguments: []goja.Value{
			runtimeB.vm.ToValue("from_b"), runtimeB.vm.ToValue("b"),
		}})
		done <- result.ToBoolean()
	}()
	close(start)
	if !<-done || !<-done {
		t.Fatal("concurrent storage write failed")
	}

	storage := readStorageMap(t, filepath.Join(dataDir, "storage.json"))
	if storage["from_a"] != "a" || storage["from_b"] != "b" {
		t.Fatalf("concurrent storage writes were not merged: %#v", storage)
	}

	credStart := make(chan struct{})
	credDone := make(chan struct{}, 2)
	for _, item := range []struct {
		runtime *extensionRuntime
		key     string
	}{
		{runtimeA, "token_a"},
		{runtimeB, "token_b"},
	} {
		item := item
		go func() {
			<-credStart
			result := item.runtime.credentialsStore(goja.FunctionCall{Arguments: []goja.Value{
				item.runtime.vm.ToValue(item.key),
				item.runtime.vm.ToValue(item.key + "_value"),
			}})
			if success, _ := result.Export().(map[string]any)["success"].(bool); !success {
				t.Errorf("credentialsStore(%s) failed", item.key)
			}
			credDone <- struct{}{}
		}()
	}
	close(credStart)
	<-credDone
	<-credDone

	reader := newExtensionRuntime(ext)
	reader.RegisterAPIs(goja.New())
	for _, key := range []string{"token_a", "token_b"} {
		got := reader.credentialsGet(goja.FunctionCall{Arguments: []goja.Value{reader.vm.ToValue(key)}}).String()
		if got != key+"_value" {
			t.Fatalf("credential %s = %q", key, got)
		}
	}
}

func readStorageMap(t *testing.T, storagePath string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(storagePath)
	if err != nil {
		t.Fatalf("failed to read storage file: %v", err)
	}

	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("failed to unmarshal storage file: %v", err)
	}
	return parsed
}

func TestExtensionRuntimeStorage_AtomicWriteCompactJSON(t *testing.T) {
	ext := &loadedExtension{
		ID: "storage-test",
		Manifest: &ExtensionManifest{
			Name: "storage-test",
		},
		DataDir: t.TempDir(),
	}

	runtime := newExtensionRuntime(ext)
	runtime.RegisterAPIs(goja.New())

	setStorageValue(t, runtime, "k1", "v1")
	setStorageValue(t, runtime, "k2", 2)

	storagePath := filepath.Join(ext.DataDir, "storage.json")
	deadline := time.Now().Add(1500 * time.Millisecond)

	var raw []byte
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(storagePath)
		if err == nil {
			raw = data
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(raw) == 0 {
		t.Fatalf("storage.json was not written within timeout")
	}

	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("failed to unmarshal storage file: %v", err)
	}
	if parsed["k1"] != "v1" {
		t.Fatalf("expected k1=v1, got %v", parsed["k1"])
	}
	if parsed["k2"] != float64(2) {
		t.Fatalf("expected k2=2, got %v", parsed["k2"])
	}
	if bytes.Contains(raw, []byte("\n")) {
		t.Fatalf("expected compact JSON without indentation, got: %q", string(raw))
	}
}

func TestUnloadExtension_FlushesPendingStorage(t *testing.T) {
	ext := &loadedExtension{
		ID: "unload-storage-test",
		Manifest: &ExtensionManifest{
			Name: "unload-storage-test",
		},
		DataDir: t.TempDir(),
		VM:      goja.New(),
	}

	runtime := newExtensionRuntime(ext)
	runtime.RegisterAPIs(ext.VM)
	ext.runtime = runtime

	manager := &extensionManager{
		extensions: map[string]*loadedExtension{
			ext.ID: ext,
		},
	}

	setStorageValue(t, runtime, "persist_on_unload", true)

	if err := manager.UnloadExtension(ext.ID); err != nil {
		t.Fatalf("UnloadExtension failed: %v", err)
	}

	storagePath := filepath.Join(ext.DataDir, "storage.json")
	parsed := readStorageMap(t, storagePath)
	if parsed["persist_on_unload"] != true {
		t.Fatalf("expected pending storage value to be flushed on unload, got %v", parsed["persist_on_unload"])
	}
}
