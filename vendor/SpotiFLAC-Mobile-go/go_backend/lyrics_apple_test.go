package gobackend

import "testing"

func TestSelectBestAppleMusicSearchResultRejectsWrongSongWithMatchingArtistAndDuration(t *testing.T) {
	results := []appleMusicSearchResult{
		{
			ID:         "azul",
			SongName:   "Azul",
			ArtistName: "Guru Randhawa",
			Duration:   186000,
		},
	}

	best := selectBestAppleMusicSearchResult(
		results,
		"SIX",
		"Guru Randhawa, Kiran Bajwa, Gurjit Gill & Lavish Dhiman",
		186,
	)
	if best != nil {
		t.Fatalf("expected the unrelated Azul result to be rejected, got %#v", best)
	}
}

func TestSelectBestAppleMusicSearchResultRequiresAvailableIdentitySignals(t *testing.T) {
	tests := []struct {
		name   string
		result appleMusicSearchResult
	}{
		{
			name: "wrong artist",
			result: appleMusicSearchResult{
				ID:         "wrong-artist",
				SongName:   "SIX",
				ArtistName: "Different Artist",
				Duration:   186000,
			},
		},
		{
			name: "wrong duration",
			result: appleMusicSearchResult{
				ID:         "wrong-duration",
				SongName:   "SIX",
				ArtistName: "Guru Randhawa",
				Duration:   240000,
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			best := selectBestAppleMusicSearchResult(
				[]appleMusicSearchResult{test.result},
				"SIX",
				"Guru Randhawa",
				186,
			)
			if best != nil {
				t.Fatalf("expected mismatched result to be rejected, got %#v", best)
			}
		})
	}
}

func TestSelectBestAppleMusicSearchResultAcceptsCompatibleMetadata(t *testing.T) {
	results := []appleMusicSearchResult{
		{
			ID:         "azul",
			SongName:   "Azul",
			ArtistName: "Guru Randhawa",
			Duration:   186000,
		},
		{
			ID:         "six",
			SongName:   "SIX (feat. Kiran Bajwa)",
			ArtistName: "Guru Randhawa & Kiran Bajwa",
			Duration:   187000,
		},
	}

	best := selectBestAppleMusicSearchResult(
		results,
		"SIX",
		"Guru Randhawa, Kiran Bajwa, Gurjit Gill & Lavish Dhiman",
		186,
	)
	if best == nil || best.ID != "six" {
		t.Fatalf("expected the compatible SIX result, got %#v", best)
	}
}
