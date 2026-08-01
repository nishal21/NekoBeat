package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/afkarxyz/SpotiFLAC/backend"
)

func main() {
	initBackend()

	if len(os.Args) < 3 {
		printError("Usage: cli <spotify_url|query> <output_dir|SEARCH|METADATA>")
		os.Exit(1)
	}

	arg1 := os.Args[1]
	arg2 := os.Args[2]

	if arg2 == "SEARCH" || strings.HasPrefix(arg2, "SEARCH:") {
		handleSearch(arg1, arg2)
		return
	}

	spotifyURL := arg1
	outputDir := arg2
	isMetadataOnly := outputDir == "METADATA"

	spotifyID := extractSpotifyID(spotifyURL)
	if spotifyID == "" {
		printError("Invalid Spotify URL or track ID")
		os.Exit(1)
	}

	if !isMetadataOnly {
		if err := os.MkdirAll(outputDir, 0o755); err != nil {
			printError(fmt.Sprintf("Failed to create output directory: %v", err))
			os.Exit(1)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	trackData, err := backend.GetFilteredSpotifyData(ctx, spotifyURL, false, 0, "", nil)
	if err != nil {
		printError(fmt.Sprintf("Failed to get Spotify metadata: %v", err))
		os.Exit(1)
	}

	meta := parseTrackMetadata(trackData)
	if isMetadataOnly {
		emitMetadata(meta)
		return
	}

	trackName := meta.Name
	artistName := meta.Artists
	albumName := meta.AlbumName
	if trackName == "" {
		trackName = "Unknown Track"
	}
	if artistName == "" {
		artistName = "Unknown Artist"
	}

	audioFormat := "LOSSLESS"
	filenameFormat := "title-artist"

	filename, err := downloadWithFallback(
		spotifyID,
		spotifyURL,
		outputDir,
		audioFormat,
		filenameFormat,
		trackName,
		artistName,
		albumName,
		meta,
	)

	if err != nil {
		if backend.IsCommunityCooldownError(err) {
			printFallback(meta.FallbackQuery(), "cooldown")
			return
		}
		printFallback(meta.FallbackQuery(), "")
		return
	}

	if strings.HasPrefix(filename, "EXISTS:") {
		filename = strings.TrimPrefix(filename, "EXISTS:")
	}

	absPath, _ := filepath.Abs(filename)
	resp, _ := json.Marshal(map[string]interface{}{
		"success": true,
		"file":    absPath,
	})
	fmt.Println(string(resp))
}

func initBackend() {
	_ = backend.InitHistoryDB("SpotiFLAC-CLI")
	_ = backend.InitISRCCacheDB()
	_ = backend.CleanupLegacyTidalPublicAPIState()
	_ = backend.SanitizePersistedConfigSettings()
}

func handleSearch(query, mode string) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	offset := 0
	if strings.HasPrefix(mode, "SEARCH:") {
		fmt.Sscanf(strings.TrimPrefix(mode, "SEARCH:"), "%d", &offset)
	}

	tracks, err := backend.SearchSpotifyByType(ctx, query, "track", 20, offset)
	if err != nil {
		printError(fmt.Sprintf("Spotify search failed: %v", err))
		os.Exit(1)
	}

	resp, _ := json.Marshal(map[string]interface{}{
		"success": true,
		"tracks":  tracks,
	})
	fmt.Println(string(resp))
}

type trackMeta struct {
	Name              string
	Artists           string
	AlbumName         string
	AlbumArtist       string
	ReleaseDate       string
	CoverURL          string
	Copyright         string
	Publisher         string
	Composer          string
	TrackNumber       int
	DiscNumber        int
	TotalTracks       int
	TotalDiscs        int
}

func (m trackMeta) FallbackQuery() string {
	return strings.TrimSpace(fmt.Sprintf("%s %s", m.Name, m.Artists))
}

func parseTrackMetadata(trackData interface{}) trackMeta {
	var out trackMeta
	raw, err := json.Marshal(trackData)
	if err != nil {
		return out
	}

	var envelope struct {
		Track struct {
			Name        string `json:"name"`
			Artists     string `json:"artists"`
			AlbumName   string `json:"album_name"`
			AlbumArtist string `json:"album_artist"`
			ReleaseDate string `json:"release_date"`
			Images      string `json:"images"`
			Copyright   string `json:"copyright"`
			Publisher   string `json:"publisher"`
			Composer    string `json:"composer"`
			TrackNumber int    `json:"track_number"`
			DiscNumber  int    `json:"disc_number"`
			TotalTracks int    `json:"total_tracks"`
			TotalDiscs  int    `json:"total_discs"`
		} `json:"track"`
	}
	if json.Unmarshal(raw, &envelope) != nil {
		return out
	}

	out.Name = envelope.Track.Name
	out.Artists = envelope.Track.Artists
	out.AlbumName = envelope.Track.AlbumName
	out.AlbumArtist = envelope.Track.AlbumArtist
	out.ReleaseDate = envelope.Track.ReleaseDate
	out.CoverURL = envelope.Track.Images
	out.Copyright = envelope.Track.Copyright
	out.Publisher = envelope.Track.Publisher
	out.Composer = envelope.Track.Composer
	out.TrackNumber = envelope.Track.TrackNumber
	out.DiscNumber = envelope.Track.DiscNumber
	out.TotalTracks = envelope.Track.TotalTracks
	out.TotalDiscs = envelope.Track.TotalDiscs
	return out
}

func emitMetadata(meta trackMeta) {
	response := map[string]interface{}{
		"success": true,
		"title":   meta.Name,
		"artist":  meta.Artists,
		"album":   meta.AlbumName,
	}
	if meta.CoverURL != "" {
		response["cover"] = meta.CoverURL
	}
	resp, _ := json.MarshalIndent(response, "", "  ")
	fmt.Println(string(resp))
}

func downloadWithFallback(
	spotifyID, spotifyURL, outputDir, audioFormat, filenameFormat string,
	trackName, artistName, albumName string,
	meta trackMeta,
) (string, error) {
	albumArtist := meta.AlbumArtist
	if albumArtist == "" {
		albumArtist = artistName
	}

	// v7.2.0 signatures: allowFallback, allowAtmosFallback, atmosFallbackQuality,
	// useFirstArtistOnly, useSingleGenre, embedGenre (Qobuz has no Atmos args).
	tidal := backend.NewTidalDownloader("")
	filename, err := tidal.Download(
		spotifyID, outputDir, audioFormat, filenameFormat,
		false, 0,
		trackName, artistName, albumName, albumArtist, meta.ReleaseDate,
		true, meta.CoverURL, true,
		meta.TrackNumber, meta.DiscNumber, meta.TotalTracks, meta.TotalDiscs,
		meta.Copyright, meta.Publisher, meta.Composer,
		"", "", spotifyURL,
		true, false, "", false, false, true,
	)
	if err == nil {
		return filename, nil
	}
	if backend.IsCommunityCooldownError(err) {
		return "", err
	}

	amazon := backend.NewAmazonDownloader()
	filename, err = amazon.DownloadBySpotifyID(
		spotifyID, outputDir, audioFormat, filenameFormat,
		"", "",
		false, 0,
		trackName, artistName, albumName, albumArtist, meta.ReleaseDate, meta.CoverURL,
		meta.TrackNumber, meta.DiscNumber, meta.TotalTracks,
		true, meta.TotalDiscs,
		meta.Copyright, meta.Publisher, meta.Composer,
		"", "", spotifyURL,
		true, false, "", false, false, true,
	)
	if err == nil {
		return filename, nil
	}
	if backend.IsCommunityCooldownError(err) {
		return "", err
	}

	isrc, isrcErr := backend.NewSongLinkClient().GetISRCDirect(spotifyID)
	if isrcErr != nil || strings.TrimSpace(isrc) == "" {
		return "", err
	}

	qobuz := backend.NewQobuzDownloader()
	filename, err = qobuz.DownloadTrackWithISRC(
		isrc, outputDir, "6", filenameFormat,
		false, 0,
		trackName, artistName, albumName, albumArtist, meta.ReleaseDate,
		true, meta.CoverURL, true,
		meta.TrackNumber, meta.DiscNumber, meta.TotalTracks, meta.TotalDiscs,
		meta.Copyright, meta.Publisher, meta.Composer,
		"", spotifyURL, true, false, false, true,
	)
	return filename, err
}

func extractSpotifyID(spotifyURL string) string {
	parts := strings.Split(strings.TrimSpace(spotifyURL), "/")
	if len(parts) == 0 {
		return ""
	}
	id := parts[len(parts)-1]
	if strings.Contains(id, "?") {
		id = strings.Split(id, "?")[0]
	}
	return strings.TrimSpace(id)
}

func printFallback(query, reason string) {
	response := map[string]interface{}{
		"success":        false,
		"fallback":       true,
		"fallback_query": query,
	}
	if reason != "" {
		response["reason"] = reason
	}
	resp, _ := json.Marshal(response)
	fmt.Println(string(resp))
}

func printError(msg string) {
	resp, _ := json.Marshal(map[string]interface{}{
		"success": false,
		"error":   msg,
	})
	fmt.Println(string(resp))
}
