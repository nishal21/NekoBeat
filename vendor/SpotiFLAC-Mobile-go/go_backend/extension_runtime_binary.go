package gobackend

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/dop251/goja"
	//lint:ignore SA1019 Blowfish is required for legacy extension crypto compatibility.
	"golang.org/x/crypto/blowfish"
)

type runtimeBlockCipherOptions struct {
	Algorithm      string
	Mode           string
	Key            []byte
	IV             []byte
	InputEncoding  string
	OutputEncoding string
	Padding        string
}

func parseRuntimeOptionsArgument(call goja.FunctionCall, index int) map[string]any {
	if len(call.Arguments) <= index {
		return nil
	}

	value := call.Arguments[index]
	if goja.IsUndefined(value) || goja.IsNull(value) {
		return nil
	}

	exported := value.Export()
	if options, ok := exported.(map[string]any); ok {
		return options
	}
	return nil
}

func runtimeOptionString(options map[string]any, key, defaultValue string) string {
	if options == nil {
		return defaultValue
	}
	raw, ok := options[key]
	if !ok || raw == nil {
		return defaultValue
	}
	switch value := raw.(type) {
	case string:
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	case []byte:
		if len(value) > 0 {
			return string(value)
		}
	}
	return defaultValue
}

func runtimeOptionBool(options map[string]any, key string, defaultValue bool) bool {
	if options == nil {
		return defaultValue
	}
	raw, ok := options[key]
	if !ok || raw == nil {
		return defaultValue
	}
	switch value := raw.(type) {
	case bool:
		return value
	case int:
		return value != 0
	case int64:
		return value != 0
	case float64:
		return value != 0
	case string:
		switch strings.ToLower(strings.TrimSpace(value)) {
		case "1", "true", "yes", "on":
			return true
		case "0", "false", "no", "off":
			return false
		}
	}
	return defaultValue
}

func runtimeOptionInt64(options map[string]any, key string, defaultValue int64) int64 {
	if options == nil {
		return defaultValue
	}
	raw, ok := options[key]
	if !ok || raw == nil {
		return defaultValue
	}
	switch value := raw.(type) {
	case int:
		return int64(value)
	case int32:
		return int64(value)
	case int64:
		return value
	case float32:
		return int64(value)
	case float64:
		return int64(value)
	case string:
		value = strings.TrimSpace(value)
		if value == "" {
			return defaultValue
		}
		var parsed int64
		if _, err := fmt.Sscanf(value, "%d", &parsed); err == nil {
			return parsed
		}
	}
	return defaultValue
}

func runtimeOptionHasKey(options map[string]any, key string) bool {
	if options == nil {
		return false
	}
	_, exists := options[key]
	return exists
}

func decodeRuntimeBytesString(input, encoding string) ([]byte, error) {
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "", "utf8", "utf-8", "text":
		return []byte(input), nil
	case "base64":
		decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(input))
		if err != nil {
			return nil, fmt.Errorf("invalid base64 data: %w", err)
		}
		return decoded, nil
	case "hex":
		decoded, err := hex.DecodeString(strings.TrimSpace(input))
		if err != nil {
			return nil, fmt.Errorf("invalid hex data: %w", err)
		}
		return decoded, nil
	default:
		return nil, fmt.Errorf("unsupported byte encoding: %s", encoding)
	}
}

func decodeRuntimeBytesValue(raw any, encoding string) ([]byte, error) {
	switch value := raw.(type) {
	case string:
		return decodeRuntimeBytesString(value, encoding)
	case []byte:
		cloned := make([]byte, len(value))
		copy(cloned, value)
		return cloned, nil
	case goja.ArrayBuffer:
		src := value.Bytes()
		cloned := make([]byte, len(src))
		copy(cloned, src)
		return cloned, nil
	case []any:
		decoded := make([]byte, len(value))
		for i, item := range value {
			switch num := item.(type) {
			case int:
				decoded[i] = byte(num)
			case int64:
				decoded[i] = byte(num)
			case float64:
				decoded[i] = byte(int(num))
			default:
				return nil, fmt.Errorf("unsupported byte array item at index %d", i)
			}
		}
		return decoded, nil
	default:
		return nil, fmt.Errorf("unsupported byte payload type")
	}
}

func encodeRuntimeBytes(data []byte, encoding string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "", "base64":
		return base64.StdEncoding.EncodeToString(data), nil
	case "hex":
		return hex.EncodeToString(data), nil
	case "utf8", "utf-8", "text":
		return string(data), nil
	default:
		return "", fmt.Errorf("unsupported byte encoding: %s", encoding)
	}
}

func parseRuntimeBlockCipherOptions(options map[string]any) (*runtimeBlockCipherOptions, error) {
	parsed := &runtimeBlockCipherOptions{
		Algorithm:      strings.ToLower(runtimeOptionString(options, "algorithm", "")),
		Mode:           strings.ToLower(runtimeOptionString(options, "mode", "cbc")),
		InputEncoding:  strings.ToLower(runtimeOptionString(options, "inputEncoding", "base64")),
		OutputEncoding: strings.ToLower(runtimeOptionString(options, "outputEncoding", "base64")),
		Padding:        strings.ToLower(runtimeOptionString(options, "padding", "none")),
	}
	if parsed.Algorithm == "" {
		return nil, fmt.Errorf("algorithm is required")
	}
	if parsed.Mode == "" {
		return nil, fmt.Errorf("mode is required")
	}

	key, err := decodeRuntimeBytesString(runtimeOptionString(options, "key", ""), runtimeOptionString(options, "keyEncoding", "utf8"))
	if err != nil {
		return nil, fmt.Errorf("invalid key: %w", err)
	}
	if len(key) == 0 {
		return nil, fmt.Errorf("key is required")
	}
	parsed.Key = key

	iv, err := decodeRuntimeBytesString(runtimeOptionString(options, "iv", ""), runtimeOptionString(options, "ivEncoding", "utf8"))
	if err != nil {
		return nil, fmt.Errorf("invalid iv: %w", err)
	}
	parsed.IV = iv
	return parsed, nil
}

func newRuntimeBlockCipher(options *runtimeBlockCipherOptions) (cipher.Block, error) {
	switch options.Algorithm {
	case "blowfish":
		return blowfish.NewCipher(options.Key)
	case "aes":
		return aes.NewCipher(options.Key)
	default:
		return nil, fmt.Errorf("unsupported block cipher algorithm: %s", options.Algorithm)
	}
}

func applyPKCS7Padding(data []byte, blockSize int) []byte {
	padding := blockSize - (len(data) % blockSize)
	if padding == 0 {
		padding = blockSize
	}
	out := make([]byte, len(data)+padding)
	copy(out, data)
	for i := len(data); i < len(out); i++ {
		out[i] = byte(padding)
	}
	return out
}

func removePKCS7Padding(data []byte, blockSize int) ([]byte, error) {
	if len(data) == 0 || len(data)%blockSize != 0 {
		return nil, fmt.Errorf("invalid padded payload length")
	}
	padding := int(data[len(data)-1])
	if padding <= 0 || padding > blockSize || padding > len(data) {
		return nil, fmt.Errorf("invalid PKCS7 padding")
	}
	for i := len(data) - padding; i < len(data); i++ {
		if int(data[i]) != padding {
			return nil, fmt.Errorf("invalid PKCS7 padding")
		}
	}
	return data[:len(data)-padding], nil
}

func (r *extensionRuntime) transformBlockCipher(call goja.FunctionCall, decrypt bool) goja.Value {
	if len(call.Arguments) < 2 {
		return r.jsError("data and options are required")
	}

	options := parseRuntimeOptionsArgument(call, 1)
	parsedOptions, err := parseRuntimeBlockCipherOptions(options)
	if err != nil {
		return r.jsError("%s", err.Error())
	}
	switch parsedOptions.Mode {
	case "cbc", "ctr":
	default:
		return r.jsError("unsupported block cipher mode: %s", parsedOptions.Mode)
	}

	inputData, err := decodeRuntimeBytesValue(call.Arguments[0].Export(), parsedOptions.InputEncoding)
	if err != nil {
		return r.jsError("%s", err.Error())
	}

	block, err := newRuntimeBlockCipher(parsedOptions)
	if err != nil {
		return r.jsError("%s", err.Error())
	}

	if len(parsedOptions.IV) != block.BlockSize() {
		ivLabel := "iv"
		if parsedOptions.Mode == "ctr" {
			ivLabel = "iv (counter)"
		}
		return r.jsError("%s must be %d bytes for %s", ivLabel, block.BlockSize(), parsedOptions.Algorithm)
	}

	var output []byte
	if parsedOptions.Mode == "ctr" {
		// CTR is a stream mode: encryption and decryption are identical,
		// require no padding, and accept arbitrary input lengths.
		output = make([]byte, len(inputData))
		cipher.NewCTR(block, parsedOptions.IV).XORKeyStream(output, inputData)
	} else {
		data := inputData
		if !decrypt && parsedOptions.Padding == "pkcs7" {
			data = applyPKCS7Padding(data, block.BlockSize())
		}
		if len(data)%block.BlockSize() != 0 {
			return r.jsError("input length must be a multiple of %d bytes", block.BlockSize())
		}

		output = make([]byte, len(data))
		if decrypt {
			cipher.NewCBCDecrypter(block, parsedOptions.IV).CryptBlocks(output, data)
			if parsedOptions.Padding == "pkcs7" {
				output, err = removePKCS7Padding(output, block.BlockSize())
				if err != nil {
					return r.jsError("%s", err.Error())
				}
			}
		} else {
			cipher.NewCBCEncrypter(block, parsedOptions.IV).CryptBlocks(output, data)
		}
	}

	encoded, err := encodeRuntimeBytes(output, parsedOptions.OutputEncoding)
	if err != nil {
		return r.jsError("%s", err.Error())
	}

	return r.jsSuccess(map[string]any{
		"data":       encoded,
		"block_size": block.BlockSize(),
	})
}

func (r *extensionRuntime) encryptBlockCipher(call goja.FunctionCall) goja.Value {
	return r.transformBlockCipher(call, false)
}

func (r *extensionRuntime) decryptBlockCipher(call goja.FunctionCall) goja.Value {
	return r.transformBlockCipher(call, true)
}

// decryptCTRSegments decrypts many independently-IV'd AES-CTR segments inside a
// single buffer in one host call. This exists to avoid thousands of JS->Go
// bridge crossings when an extension decrypts per-sample CENC media (each
// sample has its own IV/counter and cannot be merged into one stream).
//
// It is a generic primitive: any extension can use it for "one buffer, many
// CTR segments" workloads, not just Apple CENC.
//
// For best performance, pass the buffer as an ArrayBuffer/Uint8Array and set
// outputEncoding:"bytes" to get an ArrayBuffer back. This avoids base64
// encode/decode of the (potentially multi-MB) payload entirely, which is the
// dominant cost under the goja interpreter.
//
// JS signature:
//
//	utils.decryptCTRSegments(data, {
//	  algorithm: "aes",            // optional, default "aes"
//	  key: "<hex>", keyEncoding: "hex",
//	  segments: [ { offset: <int>, size: <int>, iv: "<base64>" }, ... ],
//	  ivEncoding: "base64",        // encoding of each segment.iv, default base64
//	  inputEncoding: "bytes",      // "bytes" for ArrayBuffer/Uint8Array, else base64/hex
//	  outputEncoding: "bytes"      // "bytes" -> ArrayBuffer; else base64/hex string
//	})
//
// Returns { success, data, segments_processed } or { success:false, error }.
func (r *extensionRuntime) decryptCTRSegments(call goja.FunctionCall) goja.Value {
	fail := func(msg string) goja.Value {
		return r.jsError("%s", msg)
	}

	if len(call.Arguments) < 2 {
		return fail("data and options are required")
	}

	options := parseRuntimeOptionsArgument(call, 1)
	if options == nil {
		return fail("options object is required")
	}

	algorithm := strings.ToLower(runtimeOptionString(options, "algorithm", "aes"))
	inputEncoding := strings.ToLower(runtimeOptionString(options, "inputEncoding", "base64"))
	outputEncoding := strings.ToLower(runtimeOptionString(options, "outputEncoding", "base64"))
	ivEncoding := strings.ToLower(runtimeOptionString(options, "ivEncoding", "base64"))

	key, err := decodeRuntimeBytesString(
		runtimeOptionString(options, "key", ""),
		runtimeOptionString(options, "keyEncoding", "hex"),
	)
	if err != nil {
		return fail(fmt.Sprintf("invalid key: %v", err))
	}
	if len(key) == 0 {
		return fail("key is required")
	}

	var block cipher.Block
	switch algorithm {
	case "aes":
		block, err = aes.NewCipher(key)
	case "blowfish":
		block, err = blowfish.NewCipher(key)
	default:
		return fail("unsupported algorithm: " + algorithm)
	}
	if err != nil {
		return fail(err.Error())
	}
	blockSize := block.BlockSize()

	// Decode the payload. For "bytes" input we operate on the raw []byte
	// (ArrayBuffer/Uint8Array) without any base64 round-trip.
	var data []byte
	if inputEncoding == "bytes" || inputEncoding == "raw" {
		data, err = decodeRuntimeBytesValue(call.Arguments[0].Export(), "")
		if err != nil {
			return fail("invalid byte payload: " + err.Error())
		}
	} else {
		data, err = decodeRuntimeBytesValue(call.Arguments[0].Export(), inputEncoding)
		if err != nil {
			return fail(err.Error())
		}
	}

	rawSegments, ok := options["segments"]
	if !ok || rawSegments == nil {
		return fail("segments array is required")
	}
	segments, ok := rawSegments.([]any)
	if !ok {
		return fail("segments must be an array")
	}

	processed := 0
	for i, rawSeg := range segments {
		seg, ok := rawSeg.(map[string]any)
		if !ok {
			return fail(fmt.Sprintf("segment %d is not an object", i))
		}

		offset := int(runtimeOptionInt64(seg, "offset", -1))
		size := int(runtimeOptionInt64(seg, "size", -1))
		if offset < 0 || size < 0 {
			return fail(fmt.Sprintf("segment %d has invalid offset/size", i))
		}
		if size == 0 {
			continue
		}
		if offset+size > len(data) {
			return fail(fmt.Sprintf("segment %d out of bounds (offset=%d size=%d len=%d)", i, offset, size, len(data)))
		}

		iv, err := decodeRuntimeBytesString(runtimeOptionString(seg, "iv", ""), ivEncoding)
		if err != nil {
			return fail(fmt.Sprintf("segment %d has invalid iv: %v", i, err))
		}
		if len(iv) != blockSize {
			// Accept short IVs by left-aligning into a block-sized counter
			// (CENC commonly uses 8-byte IVs for a 16-byte AES counter).
			if len(iv) > blockSize {
				return fail(fmt.Sprintf("segment %d iv longer than block size (%d > %d)", i, len(iv), blockSize))
			}
			padded := make([]byte, blockSize)
			copy(padded, iv)
			iv = padded
		}

		segData := data[offset : offset+size]
		cipher.NewCTR(block, iv).XORKeyStream(segData, segData)
		processed++
	}

	// Return raw bytes as an ArrayBuffer when requested (zero-copy-ish, no
	// base64). Otherwise fall back to an encoded string.
	if outputEncoding == "bytes" || outputEncoding == "raw" {
		return r.jsSuccess(map[string]any{
			"data":               r.vm.NewArrayBuffer(data),
			"segments_processed": processed,
		})
	}

	encoded, err := encodeRuntimeBytes(data, outputEncoding)
	if err != nil {
		return fail(err.Error())
	}

	return r.jsSuccess(map[string]any{
		"data":               encoded,
		"segments_processed": processed,
	})
}
