package gobackend

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"

	"github.com/dop251/goja"
)

// Isolated per-download runtimes of the same extension share the storage,
// credentials, and salt files on disk, so writers must be serialized
// process-wide; the per-runtime mutexes only cover a single VM.
var extensionFileMus sync.Map // file path -> *sync.Mutex

func extensionFileMu(path string) *sync.Mutex {
	mu, _ := extensionFileMus.LoadOrStore(path, &sync.Mutex{})
	return mu.(*sync.Mutex)
}

// writeExtensionFileLocked writes data via a temp file + rename so a reader
// never observes a torn write. Callers must hold extensionFileMu(path).
func writeExtensionFileLocked(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (r *extensionRuntime) getStoragePath() string {
	return filepath.Join(r.dataDir, "storage.json")
}

func readJSONMapFile(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return make(map[string]any), nil
		}
		return nil, err
	}
	result := make(map[string]any)
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, err
	}
	if result == nil {
		result = make(map[string]any)
	}
	return result, nil
}

func (r *extensionRuntime) refreshStorage() error {
	path := r.getStoragePath()
	fileMu := extensionFileMu(path)
	fileMu.Lock()
	snapshot, err := readJSONMapFile(path)
	fileMu.Unlock()
	if err != nil {
		return err
	}
	r.storageMu.Lock()
	r.storageCache = snapshot
	r.storageMu.Unlock()
	return nil
}

func (r *extensionRuntime) mutateStorage(mutate func(map[string]any) bool) error {
	r.storageMu.RLock()
	closed := r.storageClosed
	r.storageMu.RUnlock()
	if closed {
		return fmt.Errorf("storage is closed")
	}

	path := r.getStoragePath()
	fileMu := extensionFileMu(path)
	fileMu.Lock()
	snapshot, err := readJSONMapFile(path)
	if err == nil && mutate(snapshot) {
		var data []byte
		data, err = json.Marshal(snapshot)
		if err == nil {
			err = writeExtensionFileLocked(path, data)
		}
	}
	fileMu.Unlock()
	if err != nil {
		return err
	}

	r.storageMu.Lock()
	r.storageCache = snapshot
	r.storageMu.Unlock()
	return nil
}

func (r *extensionRuntime) flushStorageNow() error {
	// Mutations are persisted synchronously under the process-wide file lock.
	return nil
}

func (r *extensionRuntime) closeStorageFlusher() {
	r.storageMu.Lock()
	r.storageClosed = true
	r.storageMu.Unlock()
}

func (r *extensionRuntime) storageGet(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		return goja.Undefined()
	}

	key := call.Arguments[0].String()

	if err := r.refreshStorage(); err != nil {
		GoLog("[Extension:%s] Storage load error: %v\n", r.extensionID, err)
		return goja.Undefined()
	}

	r.storageMu.RLock()
	value, exists := r.storageCache[key]
	r.storageMu.RUnlock()
	if !exists {
		if len(call.Arguments) > 1 {
			return call.Arguments[1]
		}
		return goja.Undefined()
	}

	return r.vm.ToValue(value)
}

func (r *extensionRuntime) storageSet(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 2 {
		return r.vm.ToValue(false)
	}

	key := call.Arguments[0].String()
	value := call.Arguments[1].Export()

	if err := r.mutateStorage(func(storage map[string]any) bool {
		storage[key] = value
		return true
	}); err != nil {
		GoLog("[Extension:%s] Storage save error: %v\n", r.extensionID, err)
		return r.vm.ToValue(false)
	}

	return r.vm.ToValue(true)
}

func (r *extensionRuntime) storageRemove(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		return r.vm.ToValue(false)
	}

	key := call.Arguments[0].String()

	if err := r.mutateStorage(func(storage map[string]any) bool {
		if _, exists := storage[key]; !exists {
			return false
		}
		delete(storage, key)
		return true
	}); err != nil {
		GoLog("[Extension:%s] Storage save error: %v\n", r.extensionID, err)
		return r.vm.ToValue(false)
	}

	return r.vm.ToValue(true)
}

func (r *extensionRuntime) getCredentialsPath() string {
	return filepath.Join(r.dataDir, ".credentials.enc")
}

func (r *extensionRuntime) getSaltPath() string {
	return filepath.Join(r.dataDir, ".cred_salt")
}

func (r *extensionRuntime) getOrCreateSalt() ([]byte, error) {
	saltPath := r.getSaltPath()

	// Serialize concurrent runtimes: if two generated different salts, the
	// loser's credentials would become undecryptable.
	mu := extensionFileMu(saltPath)
	mu.Lock()
	defer mu.Unlock()

	salt, err := os.ReadFile(saltPath)
	if err == nil && len(salt) == 32 {
		return salt, nil
	}

	salt = make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return nil, fmt.Errorf("failed to generate salt: %w", err)
	}

	if err := writeExtensionFileLocked(saltPath, salt); err != nil {
		return nil, fmt.Errorf("failed to save salt: %w", err)
	}

	return salt, nil
}

func (r *extensionRuntime) getEncryptionKey() ([]byte, error) {
	salt, err := r.getOrCreateSalt()
	if err != nil {
		return nil, err
	}

	combined := append([]byte(r.extensionID), salt...)
	hash := sha256.Sum256(combined)
	return hash[:], nil
}

func (r *extensionRuntime) readCredentialsFileLocked() (map[string]any, error) {
	data, err := os.ReadFile(r.getCredentialsPath())
	if err != nil {
		if os.IsNotExist(err) {
			return make(map[string]any), nil
		}
		return nil, err
	}
	key, err := r.getEncryptionKey()
	if err != nil {
		return nil, fmt.Errorf("failed to get encryption key: %w", err)
	}
	decrypted, err := decryptAES(data, key)
	if err != nil {
		return nil, fmt.Errorf("failed to decrypt credentials: %w", err)
	}
	creds := make(map[string]any)
	if err := json.Unmarshal(decrypted, &creds); err != nil {
		return nil, err
	}
	if creds == nil {
		creds = make(map[string]any)
	}
	return creds, nil
}

func (r *extensionRuntime) refreshCredentials() error {
	path := r.getCredentialsPath()
	fileMu := extensionFileMu(path)
	fileMu.Lock()
	snapshot, err := r.readCredentialsFileLocked()
	fileMu.Unlock()
	if err != nil {
		return err
	}
	r.credentialsMu.Lock()
	r.credentialsCache = snapshot
	r.credentialsMu.Unlock()
	return nil
}

func (r *extensionRuntime) mutateCredentials(mutate func(map[string]any)) error {
	path := r.getCredentialsPath()
	fileMu := extensionFileMu(path)
	fileMu.Lock()
	snapshot, err := r.readCredentialsFileLocked()
	if err == nil {
		mutate(snapshot)
		var data []byte
		data, err = json.Marshal(snapshot)
		if err == nil {
			var key []byte
			key, err = r.getEncryptionKey()
			if err == nil {
				data, err = encryptAES(data, key)
			}
		}
		if err == nil {
			err = writeExtensionFileLocked(path, data)
		}
	}
	fileMu.Unlock()
	if err != nil {
		return err
	}
	r.credentialsMu.Lock()
	r.credentialsCache = snapshot
	r.credentialsMu.Unlock()
	return nil
}

func (r *extensionRuntime) credentialsStore(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 2 {
		return r.jsError("key and value are required")
	}

	key := call.Arguments[0].String()
	value := call.Arguments[1].Export()

	if err := r.mutateCredentials(func(credentials map[string]any) {
		credentials[key] = value
	}); err != nil {
		GoLog("[Extension:%s] Credentials save error: %v\n", r.extensionID, err)
		return r.jsError("%s", err.Error())
	}

	return r.jsSuccess(nil)
}

func (r *extensionRuntime) credentialsGet(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		return goja.Undefined()
	}

	key := call.Arguments[0].String()

	if err := r.refreshCredentials(); err != nil {
		GoLog("[Extension:%s] Credentials load error: %v\n", r.extensionID, err)
		return goja.Undefined()
	}

	r.credentialsMu.RLock()
	value, exists := r.credentialsCache[key]
	r.credentialsMu.RUnlock()
	if !exists {
		if len(call.Arguments) > 1 {
			return call.Arguments[1]
		}
		return goja.Undefined()
	}

	return r.vm.ToValue(value)
}

func (r *extensionRuntime) credentialsRemove(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		return r.vm.ToValue(false)
	}

	key := call.Arguments[0].String()

	if err := r.mutateCredentials(func(credentials map[string]any) {
		delete(credentials, key)
	}); err != nil {
		GoLog("[Extension:%s] Credentials save error: %v\n", r.extensionID, err)
		return r.vm.ToValue(false)
	}

	return r.vm.ToValue(true)
}

func (r *extensionRuntime) credentialsHas(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		return r.vm.ToValue(false)
	}

	key := call.Arguments[0].String()

	if err := r.refreshCredentials(); err != nil {
		return r.vm.ToValue(false)
	}

	r.credentialsMu.RLock()
	_, exists := r.credentialsCache[key]
	r.credentialsMu.RUnlock()
	return r.vm.ToValue(exists)
}

func encryptAES(plaintext []byte, key []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}

	ciphertext := gcm.Seal(nonce, nonce, plaintext, nil)
	return ciphertext, nil
}

func decryptAES(ciphertext []byte, key []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	nonceSize := gcm.NonceSize()
	if len(ciphertext) < nonceSize {
		return nil, fmt.Errorf("ciphertext too short")
	}

	nonce, ciphertext := ciphertext[:nonceSize], ciphertext[nonceSize:]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, err
	}

	return plaintext, nil
}
