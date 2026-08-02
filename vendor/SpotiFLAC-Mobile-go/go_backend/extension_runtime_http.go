package gobackend

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/dop251/goja"
)

type HTTPResponse struct {
	StatusCode int               `json:"statusCode"`
	Body       string            `json:"body"`
	Headers    map[string]string `json:"headers"`
}

const maxExtensionHTTPResponseBytes = 16 << 20

func readExtensionHTTPResponseBody(resp *http.Response) ([]byte, error) {
	body, err := io.ReadAll(
		io.LimitReader(resp.Body, maxExtensionHTTPResponseBytes+1),
	)
	if err != nil {
		return nil, err
	}
	if len(body) > maxExtensionHTTPResponseBytes {
		return nil, fmt.Errorf(
			"response body exceeds %d byte limit; use file.download for large media",
			maxExtensionHTTPResponseBytes,
		)
	}
	return body, nil
}

func setDefaultExtensionUA(req *http.Request) {
	if req.Header.Get("User-Agent") == "" {
		req.Header.Set("User-Agent", "Spotiflac-Extension/1.0")
	}
}

func (r *extensionRuntime) validateDomain(urlStr string) error {
	parsed, err := url.Parse(urlStr)
	if err != nil {
		return fmt.Errorf("invalid URL: %w", err)
	}

	if parsed.Scheme == "" {
		return fmt.Errorf("invalid URL: scheme is required")
	}
	if parsed.Scheme != "https" &&
		!(parsed.Scheme == "http" && r.manifest.Permissions.AllowHTTP) {
		return fmt.Errorf("network access denied: only https is allowed")
	}
	if parsed.User != nil {
		return fmt.Errorf("invalid URL: embedded credentials are not allowed")
	}

	domain := parsed.Hostname()
	if domain == "" {
		return fmt.Errorf("invalid URL: hostname is required")
	}

	if isPrivateIP(domain) {
		return fmt.Errorf("network access denied: private/local network '%s' not allowed", domain)
	}

	if !r.manifest.IsDomainAllowed(domain) {
		return fmt.Errorf("network access denied: domain '%s' not in allowed list", domain)
	}

	return nil
}

// parseGojaHeaders converts an exported goja value (expected map[string]any)
// into string headers. Non-map values yield an empty map.
func parseGojaHeaders(v any) map[string]string {
	headers := make(map[string]string)
	if h, ok := v.(map[string]any); ok {
		for k, val := range h {
			headers[k] = fmt.Sprintf("%v", val)
		}
	}
	return headers
}

// coerceExportedBody stringifies a request body already exported from goja:
// strings pass through, maps/arrays are JSON-encoded, anything else is %v.
func coerceExportedBody(v any) (string, error) {
	switch b := v.(type) {
	case string:
		return b, nil
	case map[string]any, []any:
		jsonBytes, err := json.Marshal(b)
		if err != nil {
			return "", fmt.Errorf("failed to stringify body: %v", err)
		}
		return string(jsonBytes), nil
	default:
		return fmt.Sprintf("%v", b), nil
	}
}

// coerceGojaBody is coerceExportedBody for a raw goja argument; undefined/null
// yield "", and the fallback uses goja's own String() conversion.
func coerceGojaBody(v goja.Value) (string, error) {
	if v == nil || goja.IsUndefined(v) || goja.IsNull(v) {
		return "", nil
	}
	switch b := v.Export().(type) {
	case string:
		return b, nil
	case map[string]any, []any:
		return coerceExportedBody(b)
	default:
		return v.String(), nil
	}
}

func flattenHTTPHeaders(h http.Header) map[string]any {
	flat := make(map[string]any, len(h))
	for k, v := range h {
		if len(v) == 1 {
			flat[k] = v[0]
		} else {
			flat[k] = v
		}
	}
	return flat
}

// checkExtensionURL extracts and allowlist-validates the URL argument.
// On failure it returns a non-nil error value to hand back to JS.
func (r *extensionRuntime) checkExtensionURL(call goja.FunctionCall) (string, goja.Value) {
	if len(call.Arguments) < 1 {
		return "", r.vm.ToValue(map[string]any{
			"error": "URL is required",
		})
	}
	urlStr := call.Arguments[0].String()
	if err := r.validateDomain(urlStr); err != nil {
		GoLog("[Extension:%s] HTTP blocked: %v\n", r.extensionID, err)
		return "", r.vm.ToValue(map[string]any{
			"error": err.Error(),
		})
	}
	return urlStr, nil
}

// doExtensionHTTP builds and executes the request, returning the extension
// response map (or {"error": ...}). defaultJSON sets Content-Type
// application/json when the caller did not provide one.
func (r *extensionRuntime) doExtensionHTTP(method, urlStr string, body io.Reader, defaultJSON bool, headers map[string]string) goja.Value {
	req, err := http.NewRequest(method, urlStr, body)
	if err != nil {
		return r.vm.ToValue(map[string]any{
			"error": err.Error(),
		})
	}
	req = r.bindDownloadCancelContext(req)

	for k, v := range headers {
		req.Header.Set(k, v)
	}
	setDefaultExtensionUA(req)
	if defaultJSON && req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := r.httpClient.Do(req)
	if err != nil {
		return r.vm.ToValue(map[string]any{
			"error": err.Error(),
		})
	}
	defer resp.Body.Close()

	respBody, err := readExtensionHTTPResponseBody(resp)
	if err != nil {
		return r.vm.ToValue(map[string]any{
			"error": err.Error(),
		})
	}

	return r.vm.ToValue(map[string]any{
		"statusCode": resp.StatusCode,
		"status":     resp.StatusCode,
		"ok":         resp.StatusCode >= 200 && resp.StatusCode < 300,
		"url":        resp.Request.URL.String(),
		"body":       string(respBody),
		"headers":    flattenHTTPHeaders(resp.Header),
	})
}

func (r *extensionRuntime) httpGet(call goja.FunctionCall) goja.Value {
	urlStr, errVal := r.checkExtensionURL(call)
	if errVal != nil {
		return errVal
	}
	headers := parseGojaHeaders(call.Argument(1).Export())
	return r.doExtensionHTTP("GET", urlStr, nil, false, headers)
}

func (r *extensionRuntime) httpPost(call goja.FunctionCall) goja.Value {
	urlStr, errVal := r.checkExtensionURL(call)
	if errVal != nil {
		return errVal
	}
	bodyStr, err := coerceGojaBody(call.Argument(1))
	if err != nil {
		return r.vm.ToValue(map[string]any{
			"error": err.Error(),
		})
	}
	headers := parseGojaHeaders(call.Argument(2).Export())
	// POST always sends a (possibly empty) body and defaults Content-Type.
	return r.doExtensionHTTP("POST", urlStr, strings.NewReader(bodyStr), true, headers)
}

func (r *extensionRuntime) httpRequest(call goja.FunctionCall) goja.Value {
	urlStr, errVal := r.checkExtensionURL(call)
	if errVal != nil {
		return errVal
	}

	method := "GET"
	var bodyStr string
	var headers map[string]string

	if opts, ok := call.Argument(1).Export().(map[string]any); ok {
		if m, ok := opts["method"].(string); ok {
			method = strings.ToUpper(m)
		}
		if bodyArg, ok := opts["body"]; ok && bodyArg != nil {
			var err error
			if bodyStr, err = coerceExportedBody(bodyArg); err != nil {
				return r.vm.ToValue(map[string]any{
					"error": err.Error(),
				})
			}
		}
		headers = parseGojaHeaders(opts["headers"])
	}

	var reqBody io.Reader
	if bodyStr != "" {
		reqBody = strings.NewReader(bodyStr)
	}
	return r.doExtensionHTTP(method, urlStr, reqBody, bodyStr != "", headers)
}

func (r *extensionRuntime) httpPut(call goja.FunctionCall) goja.Value {
	return r.httpMethodShortcut("PUT", call)
}

func (r *extensionRuntime) httpDelete(call goja.FunctionCall) goja.Value {
	return r.httpMethodShortcut("DELETE", call)
}

func (r *extensionRuntime) httpPatch(call goja.FunctionCall) goja.Value {
	return r.httpMethodShortcut("PATCH", call)
}

func (r *extensionRuntime) httpMethodShortcut(method string, call goja.FunctionCall) goja.Value {
	urlStr, errVal := r.checkExtensionURL(call)
	if errVal != nil {
		return errVal
	}

	// DELETE takes (url, headers); other methods take (url, body, headers).
	var bodyStr string
	headerArg := 1
	if method != "DELETE" {
		var err error
		if bodyStr, err = coerceGojaBody(call.Argument(1)); err != nil {
			return r.vm.ToValue(map[string]any{
				"error": err.Error(),
			})
		}
		headerArg = 2
	}
	headers := parseGojaHeaders(call.Argument(headerArg).Export())

	var reqBody io.Reader
	if bodyStr != "" {
		reqBody = strings.NewReader(bodyStr)
	}
	return r.doExtensionHTTP(method, urlStr, reqBody, bodyStr != "", headers)
}

func (r *extensionRuntime) httpClearCookies(call goja.FunctionCall) goja.Value {
	if jar, ok := r.cookieJar.(*simpleCookieJar); ok {
		jar.Clear()
		GoLog("[Extension:%s] Cookies cleared\n", r.extensionID)
		return r.vm.ToValue(true)
	}
	return r.vm.ToValue(false)
}
