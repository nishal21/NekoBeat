package main

// Spotiflac-cli — desktop bridge to SpotiFLAC Mobile go_backend extension runtime.
// NekoBeat invokes this for search / download / install / settings against .sflx packages.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	gobackend "github.com/zarz/spotiflac_android/go_backend"
)

type envelope struct {
	Cmd  string          `json:"cmd"`
	Args json.RawMessage `json:"args"`
}

type initArgs struct {
	ExtensionsDir string `json:"extensionsDir"`
	DataDir       string `json:"dataDir"`
}

type searchArgs struct {
	Query             string `json:"query"`
	Limit             int    `json:"limit"`
	IncludeExtensions bool   `json:"includeExtensions"`
	ProviderID        string `json:"providerId"`
}

type installArgs struct {
	Path string `json:"path"`
}

type settingsArgs struct {
	ExtensionID string         `json:"extensionId"`
	Settings    map[string]any `json:"settings"`
}

type priorityArgs struct {
	Download []string `json:"download"`
	Metadata []string `json:"metadata"`
}

func main() {
	if len(os.Args) < 2 {
		fail("usage: spotiflac-cli <json-request> | spotiflac-cli @request.json")
	}
	raw := os.Args[1]
	if strings.HasPrefix(raw, "@") {
		b, err := os.ReadFile(strings.TrimPrefix(raw, "@"))
		if err != nil {
			fail(err.Error())
		}
		raw = string(b)
	}
	var env envelope
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		fail("bad request json: " + err.Error())
	}
	out, err := dispatch(env.Cmd, env.Args)
	if err != nil {
		fail(err.Error())
	}
	fmt.Println(out)
}

func fail(msg string) {
	resp, _ := json.Marshal(map[string]any{"ok": false, "error": msg})
	fmt.Fprintln(os.Stderr, string(resp))
	os.Exit(1)
}

func okJSON(v any) (string, error) {
	b, err := json.Marshal(map[string]any{"ok": true, "data": v})
	return string(b), err
}

func okRaw(jsonStr string) (string, error) {
	var data any
	if err := json.Unmarshal([]byte(jsonStr), &data); err != nil {
		return okJSON(jsonStr)
	}
	return okJSON(data)
}

var (
	bootstrappedDir string
)

func ensureBootstrapped(extDir, dataDir string) error {
	extDir = strings.TrimSpace(extDir)
	dataDir = strings.TrimSpace(dataDir)
	if extDir == "" {
		extDir = strings.TrimSpace(os.Getenv("NEKOBEAT_EXT_DIR"))
	}
	if dataDir == "" {
		dataDir = strings.TrimSpace(os.Getenv("NEKOBEAT_EXT_DATA"))
	}
	if extDir == "" || dataDir == "" {
		return fmt.Errorf("extensionsDir/dataDir required (or NEKOBEAT_EXT_DIR / NEKOBEAT_EXT_DATA)")
	}
	key := extDir + "|" + dataDir
	if bootstrappedDir == key {
		return nil
	}
	if err := os.MkdirAll(extDir, 0755); err != nil {
		return err
	}
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return err
	}
	if err := gobackend.InitExtensionSystem(extDir, dataDir); err != nil {
		return err
	}
	_ = bootstrapExtensions(extDir)
	bootstrappedDir = key
	return nil
}

func dirsFromArgs(args json.RawMessage) (string, string) {
	var d struct {
		ExtensionsDir string `json:"extensionsDir"`
		DataDir       string `json:"dataDir"`
	}
	_ = json.Unmarshal(args, &d)
	return d.ExtensionsDir, d.DataDir
}

func dispatch(cmd string, args json.RawMessage) (string, error) {
	switch strings.ToLower(strings.TrimSpace(cmd)) {
	case "ping":
		return okJSON(map[string]string{"version": "0.3.1"})
	case "init":
		var a initArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return "", err
		}
		// Force re-bootstrap
		bootstrappedDir = ""
		if err := ensureBootstrapped(a.ExtensionsDir, a.DataDir); err != nil {
			return "", err
		}
		return okJSON(map[string]any{"loaded": bootstrapExtensions(a.ExtensionsDir)})
	case "load-file":
		extDir, dataDir := dirsFromArgs(args)
		if err := ensureBootstrapped(extDir, dataDir); err != nil {
			return "", err
		}
		var a installArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return "", err
		}
		s, err := gobackend.LoadExtensionFromPath(a.Path)
		if err != nil {
			msg := err.Error()
			if strings.Contains(msg, "already installed") || strings.Contains(msg, "already exists") {
				id := strings.TrimSuffix(filepath.Base(a.Path), filepath.Ext(a.Path))
				_ = gobackend.SetExtensionEnabledByID(id, true)
				return okJSON(map[string]string{"status": "already_installed", "path": a.Path, "id": id})
			}
			return "", err
		}
		var meta map[string]any
		_ = json.Unmarshal([]byte(s), &meta)
		if id, ok := meta["id"].(string); ok && id != "" {
			_ = gobackend.SetExtensionEnabledByID(id, true)
		}
		return okRaw(s)
	case "list":
		extDir, dataDir := dirsFromArgs(args)
		if err := ensureBootstrapped(extDir, dataDir); err != nil {
			return "", err
		}
		s, err := gobackend.GetInstalledExtensions()
		if err != nil {
			return "", err
		}
		return okRaw(s)
	case "search":
		extDir, dataDir := dirsFromArgs(args)
		if err := ensureBootstrapped(extDir, dataDir); err != nil {
			return "", err
		}
		var a searchArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return "", err
		}
		if a.Limit <= 0 {
			a.Limit = 20
		}
		a.IncludeExtensions = true
		var s string
		var err error
		if strings.TrimSpace(a.ProviderID) != "" {
			s, err = gobackend.SearchTracksWithMetadataProviderJSON(a.ProviderID, a.Query, a.Limit)
		} else {
			s, err = gobackend.SearchTracksWithMetadataProvidersJSON(a.Query, a.Limit, true)
		}
		if err != nil {
			return "", err
		}
		return okRaw(s)
	case "lookup-cover":
		// SpotiFLAC Mobile metadata providers → cover URL (spotify-web, amazon, …)
		extDir, dataDir := dirsFromArgs(args)
		if err := ensureBootstrapped(extDir, dataDir); err != nil {
			return "", err
		}
		var a struct {
			Artist string `json:"artist"`
			Title  string `json:"title"`
			Album  string `json:"album"`
			Query  string `json:"query"`
			Limit  int    `json:"limit"`
		}
		if err := json.Unmarshal(args, &a); err != nil {
			return "", err
		}
		q := strings.TrimSpace(a.Query)
		if q == "" {
			parts := []string{}
			if strings.TrimSpace(a.Artist) != "" {
				parts = append(parts, strings.TrimSpace(a.Artist))
			}
			if strings.TrimSpace(a.Title) != "" {
				parts = append(parts, strings.TrimSpace(a.Title))
			} else if strings.TrimSpace(a.Album) != "" {
				parts = append(parts, strings.TrimSpace(a.Album))
			}
			q = strings.Join(parts, " ")
		}
		if q == "" {
			return "", fmt.Errorf("artist/title required for cover lookup")
		}
		if a.Limit <= 0 {
			a.Limit = 8
		}
		s, err := gobackend.SearchTracksWithMetadataProvidersJSON(q, a.Limit, true)
		if err != nil {
			return "", err
		}
		var tracks []map[string]any
		if err := json.Unmarshal([]byte(s), &tracks); err != nil {
			// sometimes wrapped
			var wrap struct {
				Tracks []map[string]any `json:"tracks"`
			}
			if json.Unmarshal([]byte(s), &wrap) == nil {
				tracks = wrap.Tracks
			}
		}
		wantTitle := strings.ToLower(strings.TrimSpace(a.Title))
		wantArtist := strings.ToLower(strings.TrimSpace(a.Artist))
		pickURL := func(t map[string]any) string {
			for _, k := range []string{"cover_url", "images", "image", "artwork"} {
				if v, ok := t[k].(string); ok {
					v = strings.TrimSpace(v)
					if strings.HasPrefix(v, "http") {
						return v
					}
				}
			}
			return ""
		}
		score := func(t map[string]any) int {
			name, _ := t["name"].(string)
			if name == "" {
				name, _ = t["title"].(string)
			}
			artists, _ := t["artists"].(string)
			if artists == "" {
				artists, _ = t["artist"].(string)
			}
			n := strings.ToLower(name)
			ar := strings.ToLower(artists)
			sc := 0
			if wantTitle != "" && strings.Contains(n, wantTitle) {
				sc += 3
			}
			if wantArtist != "" && strings.Contains(ar, wantArtist) {
				sc += 2
			}
			if pickURL(t) != "" {
				sc += 1
			}
			return sc
		}
		bestURL := ""
		bestProv := ""
		bestScore := -1
		for _, t := range tracks {
			u := pickURL(t)
			if u == "" {
				continue
			}
			sc := score(t)
			if sc > bestScore {
				bestScore = sc
				bestURL = u
				bestProv, _ = t["provider_id"].(string)
			}
		}
		if bestURL == "" {
			return okJSON(map[string]any{"coverUrl": "", "providerId": ""})
		}
		// Prefer larger Spotify CDN art when present
		bestURL = strings.Replace(bestURL, "ab67616d00004851", "ab67616d0000b273", 1)
		return okJSON(map[string]any{
			"coverUrl":   bestURL,
			"providerId": bestProv,
			"query":      q,
		})
	case "download":
		extDir, dataDir := dirsFromArgs(args)
		if err := ensureBootstrapped(extDir, dataDir); err != nil {
			return "", err
		}
		s, err := gobackend.DownloadWithExtensionsJSON(string(args))
		if err != nil {
			return "", err
		}
		return okRaw(s)
	case "handle-url":
		extDir, dataDir := dirsFromArgs(args)
		if err := ensureBootstrapped(extDir, dataDir); err != nil {
			return "", err
		}
		var a struct {
			URL string `json:"url"`
		}
		if err := json.Unmarshal(args, &a); err != nil {
			return "", err
		}
		s, err := gobackend.HandleURLWithExtensionJSON(a.URL)
		if err != nil {
			return "", err
		}
		return okRaw(s)
	case "set-settings":
		extDir, dataDir := dirsFromArgs(args)
		if err := ensureBootstrapped(extDir, dataDir); err != nil {
			return "", err
		}
		var a settingsArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return "", err
		}
		b, _ := json.Marshal(a.Settings)
		if err := gobackend.SetExtensionSettingsJSON(a.ExtensionID, string(b)); err != nil {
			return "", err
		}
		return okJSON(map[string]bool{"saved": true})
	case "get-settings":
		extDir, dataDir := dirsFromArgs(args)
		if err := ensureBootstrapped(extDir, dataDir); err != nil {
			return "", err
		}
		var a struct {
			ExtensionID string `json:"extensionId"`
		}
		if err := json.Unmarshal(args, &a); err != nil {
			return "", err
		}
		s, err := gobackend.GetExtensionSettingsJSON(a.ExtensionID)
		if err != nil {
			return "", err
		}
		return okRaw(s)
	case "set-priority":
		extDir, dataDir := dirsFromArgs(args)
		if err := ensureBootstrapped(extDir, dataDir); err != nil {
			return "", err
		}
		var a priorityArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return "", err
		}
		if a.Download != nil {
			b, _ := json.Marshal(a.Download)
			if err := gobackend.SetProviderPriorityJSON(string(b)); err != nil {
				return "", err
			}
		}
		if a.Metadata != nil {
			b, _ := json.Marshal(a.Metadata)
			if err := gobackend.SetMetadataProviderPriorityJSON(string(b)); err != nil {
				return "", err
			}
		}
		return okJSON(map[string]bool{"saved": true})
	default:
		return "", fmt.Errorf("unknown cmd %q", cmd)
	}
}

func bootstrapExtensions(dir string) []string {
	var loaded []string

	// 1) Load unpacked dirs + any package files (SpotiFLAC Mobile LoadExtensionsFromDirectory)
	jsonText, err := gobackend.LoadExtensionsFromDir(dir)
	if err != nil {
		loaded = append(loaded, "dir:err:"+err.Error())
	} else {
		var parsed map[string]any
		if json.Unmarshal([]byte(jsonText), &parsed) == nil {
			if arr, ok := parsed["loaded"].([]any); ok {
				for _, v := range arr {
					if id, ok := v.(string); ok {
						loaded = append(loaded, id+":dir")
					}
				}
			}
			if arr, ok := parsed["errors"].([]any); ok {
				for _, v := range arr {
					if s, ok := v.(string); ok && s != "" {
						loaded = append(loaded, "err:"+s)
					}
				}
			}
		}
	}

	// 2) Enable every installed extension (Mobile marks them usable for search/download)
	listJSON, err := gobackend.GetInstalledExtensions()
	if err == nil {
		var list []map[string]any
		if json.Unmarshal([]byte(listJSON), &list) == nil {
			for _, ext := range list {
				id, _ := ext["id"].(string)
				if id == "" {
					id, _ = ext["name"].(string)
				}
				if id == "" {
					continue
				}
				if err := gobackend.SetExtensionEnabledByID(id, true); err != nil {
					loaded = append(loaded, id+":enable-err:"+err.Error())
				} else {
					loaded = append(loaded, id+":enabled")
				}
			}
		}
	}

	// 3) Default metadata priority like SpotiFLAC Mobile (spotify-web first)
	_ = gobackend.SetMetadataProviderPriorityJSON(`["spotify-web","amazon","apple-music","deezer","ytmusic-spotiflac","soundcloud"]`)
	_ = gobackend.SetProviderPriorityJSON(`["tidal-web","amazon","qobuz-web","deezer","ytmusic-spotiflac","soundcloud"]`)

	return loaded
}

