package gobackend

import "encoding/json"

// marshalJSONString marshals v and returns it as a string, the shape every
// gomobile export returns.
func marshalJSONString(v any) (string, error) {
	jsonBytes, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	return string(jsonBytes), nil
}
