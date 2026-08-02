package gobackend

import "time"

type cacheEntry struct {
	data      any
	expiresAt time.Time
}

func (e *cacheEntry) isExpired() bool {
	return time.Now().After(e.expiresAt)
}

type TrackMetadata struct {
	SpotifyID   string `json:"spotify_id,omitempty"`
	Artists     string `json:"artists"`
	Name        string `json:"name"`
	AlbumName   string `json:"album_name"`
	AlbumArtist string `json:"album_artist,omitempty"`
	DurationMS  int    `json:"duration_ms"`
	Images      string `json:"images"`
	ReleaseDate string `json:"release_date"`
	TrackNumber int    `json:"track_number"`
	TotalTracks int    `json:"total_tracks,omitempty"`
	DiscNumber  int    `json:"disc_number,omitempty"`
	TotalDiscs  int    `json:"total_discs,omitempty"`
	ExternalURL string `json:"external_urls"`
	ISRC        string `json:"isrc"`
	AlbumID     string `json:"album_id,omitempty"`
	ArtistID    string `json:"artist_id,omitempty"`
	AlbumType   string `json:"album_type,omitempty"`
	Composer    string `json:"composer,omitempty"`
	Explicit    bool   `json:"explicit,omitempty"`
}

type AlbumTrackMetadata struct {
	SpotifyID   string `json:"spotify_id,omitempty"`
	Artists     string `json:"artists"`
	Name        string `json:"name"`
	AlbumName   string `json:"album_name"`
	AlbumArtist string `json:"album_artist,omitempty"`
	DurationMS  int    `json:"duration_ms"`
	Images      string `json:"images"`
	ReleaseDate string `json:"release_date"`
	TrackNumber int    `json:"track_number"`
	TotalTracks int    `json:"total_tracks,omitempty"`
	DiscNumber  int    `json:"disc_number,omitempty"`
	TotalDiscs  int    `json:"total_discs,omitempty"`
	ExternalURL string `json:"external_urls"`
	ISRC        string `json:"isrc"`
	AlbumID     string `json:"album_id,omitempty"`
	AlbumURL    string `json:"album_url,omitempty"`
	AlbumType   string `json:"album_type,omitempty"`
	Composer    string `json:"composer,omitempty"`
	Explicit    bool   `json:"explicit,omitempty"`
}

type AlbumInfoMetadata struct {
	TotalTracks int    `json:"total_tracks"`
	Name        string `json:"name"`
	ReleaseDate string `json:"release_date"`
	Artists     string `json:"artists"`
	ArtistId    string `json:"artist_id,omitempty"`
	Images      string `json:"images"`
	Genre       string `json:"genre,omitempty"`
	Label       string `json:"label,omitempty"`
	Copyright   string `json:"copyright,omitempty"`
}

type AlbumResponsePayload struct {
	AlbumInfo AlbumInfoMetadata    `json:"album_info"`
	TrackList []AlbumTrackMetadata `json:"track_list"`
}

type PlaylistInfoMetadata struct {
	Name   string `json:"name,omitempty"`
	Images string `json:"images,omitempty"`
	Tracks struct {
		Total int `json:"total"`
	} `json:"tracks"`
	Owner struct {
		DisplayName string `json:"display_name"`
		Name        string `json:"name"`
		Images      string `json:"images"`
	} `json:"owner"`
}

type PlaylistResponsePayload struct {
	PlaylistInfo PlaylistInfoMetadata `json:"playlist_info"`
	TrackList    []AlbumTrackMetadata `json:"track_list"`
}

type ArtistInfoMetadata struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Images     string `json:"images"`
	Followers  int    `json:"followers"`
	Popularity int    `json:"popularity"`
}

type ArtistAlbumMetadata struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	ReleaseDate string `json:"release_date"`
	TotalTracks int    `json:"total_tracks"`
	Images      string `json:"images"`
	AlbumType   string `json:"album_type"`
	Artists     string `json:"artists"`
}

type ArtistResponsePayload struct {
	ArtistInfo ArtistInfoMetadata    `json:"artist_info"`
	Albums     []ArtistAlbumMetadata `json:"albums"`
}

type TrackResponse struct {
	Track TrackMetadata `json:"track"`
}

type SearchArtistResult struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Images     string `json:"images"`
	Followers  int    `json:"followers"`
	Popularity int    `json:"popularity"`
}

type SearchAlbumResult struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Artists     string `json:"artists"`
	Images      string `json:"images"`
	ReleaseDate string `json:"release_date"`
	TotalTracks int    `json:"total_tracks"`
	AlbumType   string `json:"album_type"`
}

type SearchPlaylistResult struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Owner       string `json:"owner"`
	Images      string `json:"images"`
	TotalTracks int    `json:"total_tracks"`
}

type SearchAllResult struct {
	Tracks    []TrackMetadata        `json:"tracks"`
	Artists   []SearchArtistResult   `json:"artists"`
	Albums    []SearchAlbumResult    `json:"albums"`
	Playlists []SearchPlaylistResult `json:"playlists"`
}
