package gobackend

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEditM4AFreeformTextWritesISRCAndLabel(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "track.m4a")

	ilst := buildM4ATextTag("\xa9nam", "Title")
	if err := os.WriteFile(path, buildM4AFileWithIlst(ilst, true), 0600); err != nil {
		t.Fatal(err)
	}

	if err := EditM4AFreeformText(path, map[string]string{
		"isrc":  "USRC17607839",
		"label": "Some Label",
	}); err != nil {
		t.Fatalf("EditM4AFreeformText: %v", err)
	}

	meta, err := ReadM4ATags(path)
	if err != nil {
		t.Fatalf("ReadM4ATags: %v", err)
	}
	if meta.ISRC != "USRC17607839" {
		t.Fatalf("ISRC = %q, want USRC17607839", meta.ISRC)
	}
	if meta.Label != "Some Label" {
		t.Fatalf("Label = %q, want Some Label", meta.Label)
	}
	if meta.Title != "Title" {
		t.Fatalf("Title = %q, want Title (existing tag must survive)", meta.Title)
	}
}

func TestEditM4AFreeformTextReplacesExisting(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "track.m4a")

	ilst := buildM4ATextTag("\xa9nam", "Title")
	ilst = append(ilst, buildM4AFreeformAtom("ISRC", "OLDISRC00001")...)
	ilst = append(ilst, buildM4AFreeformAtom("LABEL", "Old Label")...)
	if err := os.WriteFile(path, buildM4AFileWithIlst(ilst, true), 0600); err != nil {
		t.Fatal(err)
	}

	if err := EditM4AFreeformText(path, map[string]string{
		"isrc":  "NEWISRC00002",
		"label": "",
	}); err != nil {
		t.Fatalf("EditM4AFreeformText: %v", err)
	}

	meta, err := ReadM4ATags(path)
	if err != nil {
		t.Fatalf("ReadM4ATags: %v", err)
	}
	if meta.ISRC != "NEWISRC00002" {
		t.Fatalf("ISRC = %q, want NEWISRC00002", meta.ISRC)
	}
	if meta.Label != "" {
		t.Fatalf("Label = %q, want empty (cleared)", meta.Label)
	}
}
