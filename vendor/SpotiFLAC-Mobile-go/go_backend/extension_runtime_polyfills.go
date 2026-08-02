package gobackend

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/dop251/goja"
)

func (r *extensionRuntime) fetchPolyfill(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		return r.createFetchError("URL is required")
	}

	urlStr := call.Arguments[0].String()
	if err := r.validateDomain(urlStr); err != nil {
		GoLog("[Extension:%s] fetch blocked: %v\n", r.extensionID, err)
		return r.createFetchError(err.Error())
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
				return r.createFetchError(err.Error())
			}
		}
		headers = parseGojaHeaders(opts["headers"])
	}

	var reqBody io.Reader
	if bodyStr != "" {
		reqBody = strings.NewReader(bodyStr)
	}

	req, err := http.NewRequest(method, urlStr, reqBody)
	if err != nil {
		return r.createFetchError(err.Error())
	}
	req = r.bindDownloadCancelContext(req)

	for k, v := range headers {
		req.Header.Set(k, v)
	}
	if req.Header.Get("User-Agent") == "" {
		req.Header.Set("User-Agent", appUserAgent())
	}
	if bodyStr != "" && req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := r.httpClient.Do(req)
	if err != nil {
		return r.createFetchError(err.Error())
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return r.createFetchError(err.Error())
	}

	respHeaders := flattenHTTPHeaders(resp.Header)

	responseObj := r.vm.NewObject()
	responseObj.Set("ok", resp.StatusCode >= 200 && resp.StatusCode < 300)
	responseObj.Set("status", resp.StatusCode)
	responseObj.Set("statusText", http.StatusText(resp.StatusCode))
	responseObj.Set("headers", respHeaders)
	responseObj.Set("url", resp.Request.URL.String())

	bodyString := string(body)

	responseObj.Set("text", func(call goja.FunctionCall) goja.Value {
		return r.vm.ToValue(bodyString)
	})

	responseObj.Set("json", func(call goja.FunctionCall) goja.Value {
		var result any
		if err := json.Unmarshal(body, &result); err != nil {
			GoLog("[Extension:%s] fetch json() parse error: %v\n", r.extensionID, err)
			return goja.Undefined()
		}
		return r.vm.ToValue(result)
	})

	responseObj.Set("arrayBuffer", func(call goja.FunctionCall) goja.Value {
		byteArray := make([]any, len(body))
		for i, b := range body {
			byteArray[i] = int(b)
		}
		return r.vm.ToValue(byteArray)
	})

	return responseObj
}

func (r *extensionRuntime) createFetchError(message string) goja.Value {
	errorObj := r.vm.NewObject()
	errorObj.Set("ok", false)
	errorObj.Set("status", 0)
	errorObj.Set("statusText", "Network Error")
	errorObj.Set("error", message)
	errorObj.Set("text", func(call goja.FunctionCall) goja.Value {
		return r.vm.ToValue("")
	})
	errorObj.Set("json", func(call goja.FunctionCall) goja.Value {
		return goja.Undefined()
	})
	return errorObj
}

func (r *extensionRuntime) atobPolyfill(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		return r.vm.ToValue("")
	}
	input := call.Arguments[0].String()
	decoded, err := base64.StdEncoding.DecodeString(input)
	if err != nil {
		decoded, err = base64.URLEncoding.DecodeString(input)
		if err != nil {
			GoLog("[Extension:%s] atob decode error: %v\n", r.extensionID, err)
			return r.vm.ToValue("")
		}
	}
	return r.vm.ToValue(string(decoded))
}

func (r *extensionRuntime) btoaPolyfill(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		return r.vm.ToValue("")
	}
	input := call.Arguments[0].String()
	return r.vm.ToValue(base64.StdEncoding.EncodeToString([]byte(input)))
}

func (r *extensionRuntime) registerTextEncoderDecoder(vm *goja.Runtime) {
	vm.Set("TextEncoder", func(call goja.ConstructorCall) *goja.Object {
		encoder := call.This
		encoder.Set("encoding", "utf-8")

		encoder.Set("encode", func(call goja.FunctionCall) goja.Value {
			if len(call.Arguments) < 1 {
				return vm.ToValue([]byte{})
			}
			input := call.Arguments[0].String()
			bytes := []byte(input)

			result := make([]any, len(bytes))
			for i, b := range bytes {
				result[i] = int(b)
			}
			return vm.ToValue(result)
		})

		encoder.Set("encodeInto", func(call goja.FunctionCall) goja.Value {
			if len(call.Arguments) < 2 {
				return vm.ToValue(map[string]any{"read": 0, "written": 0})
			}
			input := call.Arguments[0].String()
			return vm.ToValue(map[string]any{
				"read":    len(input),
				"written": len([]byte(input)),
			})
		})

		return nil
	})

	vm.Set("TextDecoder", func(call goja.ConstructorCall) *goja.Object {
		decoder := call.This

		encoding := "utf-8"
		if len(call.Arguments) > 0 && !goja.IsUndefined(call.Arguments[0]) {
			encoding = call.Arguments[0].String()
		}
		decoder.Set("encoding", encoding)
		decoder.Set("fatal", false)
		decoder.Set("ignoreBOM", false)

		decoder.Set("decode", func(call goja.FunctionCall) goja.Value {
			if len(call.Arguments) < 1 {
				return vm.ToValue("")
			}

			input := call.Arguments[0].Export()
			var bytes []byte

			switch v := input.(type) {
			case []byte:
				bytes = v
			case []any:
				bytes = make([]byte, len(v))
				for i, val := range v {
					switch n := val.(type) {
					case int64:
						bytes[i] = byte(n)
					case float64:
						bytes[i] = byte(n)
					case int:
						bytes[i] = byte(n)
					}
				}
			case string:
				return vm.ToValue(v)
			default:
				return vm.ToValue("")
			}

			return vm.ToValue(string(bytes))
		})

		return nil
	})
}

func (r *extensionRuntime) registerURLClass(vm *goja.Runtime) {
	vm.Set("URL", func(call goja.ConstructorCall) *goja.Object {
		urlObj := call.This

		if len(call.Arguments) < 1 {
			urlObj.Set("href", "")
			return nil
		}

		urlStr := call.Arguments[0].String()

		if len(call.Arguments) > 1 && !goja.IsUndefined(call.Arguments[1]) {
			baseStr := call.Arguments[1].String()
			baseURL, err := url.Parse(baseStr)
			if err == nil {
				relURL, err := url.Parse(urlStr)
				if err == nil {
					urlStr = baseURL.ResolveReference(relURL).String()
				}
			}
		}

		parsed, err := url.Parse(urlStr)
		if err != nil {
			urlObj.Set("href", urlStr)
			return nil
		}

		urlObj.Set("href", parsed.String())
		urlObj.Set("protocol", parsed.Scheme+":")
		urlObj.Set("host", parsed.Host)
		urlObj.Set("hostname", parsed.Hostname())
		urlObj.Set("port", parsed.Port())
		urlObj.Set("pathname", parsed.Path)
		urlObj.Set("search", "")
		if parsed.RawQuery != "" {
			urlObj.Set("search", "?"+parsed.RawQuery)
		}
		urlObj.Set("hash", "")
		if parsed.Fragment != "" {
			urlObj.Set("hash", "#"+parsed.Fragment)
		}
		urlObj.Set("origin", parsed.Scheme+"://"+parsed.Host)
		urlObj.Set("username", parsed.User.Username())
		password, _ := parsed.User.Password()
		urlObj.Set("password", password)

		queryValues := parsed.Query()

		searchParams := vm.NewObject()
		searchParams.Set("get", func(call goja.FunctionCall) goja.Value {
			if len(call.Arguments) < 1 {
				return goja.Null()
			}
			key := call.Arguments[0].String()
			if val := queryValues.Get(key); val != "" {
				return vm.ToValue(val)
			}
			return goja.Null()
		})

		searchParams.Set("getAll", func(call goja.FunctionCall) goja.Value {
			if len(call.Arguments) < 1 {
				return vm.ToValue([]string{})
			}
			key := call.Arguments[0].String()
			return vm.ToValue(queryValues[key])
		})

		searchParams.Set("has", func(call goja.FunctionCall) goja.Value {
			if len(call.Arguments) < 1 {
				return vm.ToValue(false)
			}
			key := call.Arguments[0].String()
			return vm.ToValue(queryValues.Has(key))
		})

		searchParams.Set("toString", func(call goja.FunctionCall) goja.Value {
			return vm.ToValue(queryValues.Encode())
		})

		urlObj.Set("searchParams", searchParams)

		urlObj.Set("toString", func(call goja.FunctionCall) goja.Value {
			return vm.ToValue(parsed.String())
		})

		urlObj.Set("toJSON", func(call goja.FunctionCall) goja.Value {
			return vm.ToValue(parsed.String())
		})

		return nil
	})

	vm.Set("URLSearchParams", func(call goja.ConstructorCall) *goja.Object {
		paramsObj := call.This
		values := url.Values{}

		if len(call.Arguments) > 0 && !goja.IsUndefined(call.Arguments[0]) {
			init := call.Arguments[0].Export()
			switch v := init.(type) {
			case string:
				parsed, _ := url.ParseQuery(strings.TrimPrefix(v, "?"))
				values = parsed
			case map[string]any:
				for k, val := range v {
					values.Set(k, fmt.Sprintf("%v", val))
				}
			}
		}

		paramsObj.Set("append", func(call goja.FunctionCall) goja.Value {
			if len(call.Arguments) >= 2 {
				values.Add(call.Arguments[0].String(), call.Arguments[1].String())
			}
			return goja.Undefined()
		})

		paramsObj.Set("delete", func(call goja.FunctionCall) goja.Value {
			if len(call.Arguments) >= 1 {
				values.Del(call.Arguments[0].String())
			}
			return goja.Undefined()
		})

		paramsObj.Set("get", func(call goja.FunctionCall) goja.Value {
			if len(call.Arguments) < 1 {
				return goja.Null()
			}
			if val := values.Get(call.Arguments[0].String()); val != "" {
				return vm.ToValue(val)
			}
			return goja.Null()
		})

		paramsObj.Set("getAll", func(call goja.FunctionCall) goja.Value {
			if len(call.Arguments) < 1 {
				return vm.ToValue([]string{})
			}
			return vm.ToValue(values[call.Arguments[0].String()])
		})

		paramsObj.Set("has", func(call goja.FunctionCall) goja.Value {
			if len(call.Arguments) < 1 {
				return vm.ToValue(false)
			}
			return vm.ToValue(values.Has(call.Arguments[0].String()))
		})

		paramsObj.Set("set", func(call goja.FunctionCall) goja.Value {
			if len(call.Arguments) >= 2 {
				values.Set(call.Arguments[0].String(), call.Arguments[1].String())
			}
			return goja.Undefined()
		})

		paramsObj.Set("toString", func(call goja.FunctionCall) goja.Value {
			return vm.ToValue(values.Encode())
		})

		return nil
	})
}

func (r *extensionRuntime) registerJSONGlobal(vm *goja.Runtime) {
	jsonScript := `
		if (typeof JSON === 'undefined') {
			var JSON = {
				parse: function(text) {
					return utils.parseJSON(text);
				},
				stringify: function(value, replacer, space) {
					return utils.stringifyJSON(value);
				}
			};
		}
	`
	_, _ = vm.RunString(jsonScript)
}
