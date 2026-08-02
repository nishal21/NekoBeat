package gobackend

import (
	"encoding/json"
	"testing"
)

func TestLyricsSearchSelectorsRejectUnrelatedSongWithMatchingArtistAndDuration(t *testing.T) {
	const (
		trackName   = "SIX"
		artistName  = "Guru Randhawa"
		durationSec = 186
	)

	if best := selectBestSpotifyLyricsSearchResult(
		[]spotifyLyricsSearchResult{{
			TrackID:    "azul",
			Name:       "Azul",
			ArtistName: artistName,
			Duration:   "3:06",
		}},
		trackName,
		artistName,
		durationSec,
	); best != nil {
		t.Fatalf("Spotify accepted unrelated result: %#v", best)
	}

	if best := selectBestYouTubeLyricsSearchResult(
		[]youtubeLyricsSearchResult{{
			VideoID:  "azul",
			Title:    "Azul",
			Author:   artistName,
			Duration: "3:06",
		}},
		trackName,
		artistName,
		durationSec,
	); best != nil {
		t.Fatalf("YouTube accepted unrelated result: %#v", best)
	}

	if best := selectBestKugouLyricsSearchResult(
		[]kugouLyricsSearchResult{{
			Hash:     "azul",
			Title:    "Azul",
			Artist:   artistName,
			Duration: durationSec,
		}},
		trackName,
		artistName,
		durationSec,
	); best != nil {
		t.Fatalf("Kugou accepted unrelated result: %#v", best)
	}

	var geniusResults geniusSearchResponse
	if err := json.Unmarshal([]byte(`{
		"response": {
			"sections": [{
				"hits": [{
					"type": "song",
					"result": {
						"title": "Azul",
						"primary_artist_names": "Guru Randhawa",
						"url": "https://genius.com/guru-randhawa-azul-lyrics"
					}
				}]
			}]
		}
	}`), &geniusResults); err != nil {
		t.Fatalf("decode Genius fixture: %v", err)
	}
	if bestURL := selectBestGeniusLyricsSearchResult(
		geniusResults,
		trackName,
		artistName,
		durationSec,
	); bestURL != "" {
		t.Fatalf("Genius accepted unrelated result: %q", bestURL)
	}

	var neteaseResults neteaseSearchResponse
	if err := json.Unmarshal([]byte(`{
		"result": {
			"songCount": 1,
			"songs": [{
				"name": "Azul",
				"id": 123,
				"artists": [{"name": "Guru Randhawa"}]
			}]
		},
		"code": 200
	}`), &neteaseResults); err != nil {
		t.Fatalf("decode Netease fixture: %v", err)
	}
	if best := selectBestNeteaseSearchResult(
		neteaseResults.Result.Songs,
		trackName,
		artistName,
	); best != nil {
		t.Fatalf("Netease accepted unrelated result: %#v", best)
	}

	lrclibResult := &LRCLibResponse{
		TrackName:    "Azul",
		ArtistName:   artistName,
		Duration:     durationSec,
		SyncedLyrics: "[00:01.00]Wrong",
	}
	if lrclibSearchResultMatches(
		lrclibResult,
		"Guru Randhawa SIX",
		trackName,
		artistName,
		durationSec,
	) {
		t.Fatalf("LRCLIB accepted unrelated result: %#v", lrclibResult)
	}
}

func TestYouTubeLyricsSearchAllowsDecoratedTitleWithArtistSignal(t *testing.T) {
	results := []youtubeLyricsSearchResult{{
		VideoID:  "six",
		Title:    "Guru Randhawa - SIX (Official Music Video)",
		Author:   "T-Series",
		Duration: "3:06",
	}}

	best := selectBestYouTubeLyricsSearchResult(
		results,
		"SIX",
		"Guru Randhawa",
		186,
	)
	if best == nil || best.VideoID != "six" {
		t.Fatalf("expected decorated YouTube result to match, got %#v", best)
	}
}

func TestDecoratedLyricsTitleMatchingUsesWholeWords(t *testing.T) {
	if !lyricsSearchTitlesMatch(
		"Guru Randhawa - SIX (Official Music Video)",
		"SIX",
		true,
	) {
		t.Fatal("expected decorated SIX title to match")
	}
	if lyricsSearchTitlesMatch("SIXTEEN", "SIX", true) {
		t.Fatal("SIX must not match SIXTEEN")
	}
	if lyricsSearchArtistsMatch("Guru Randhawa Tribute", "Guru Randhawa") {
		t.Fatal("artist matching must not accept a longer unrelated name")
	}
}
