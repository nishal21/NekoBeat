package gobackend

import (
	"encoding/json"
	"testing"
)

func TestItemProgressPreparingAndDownloadingStatuses(t *testing.T) {
	const itemID = "progress-phase-item"
	RemoveItemProgress(itemID)
	defer RemoveItemProgress(itemID)

	StartItemProgress(itemID)
	SetItemPreparing(itemID)

	if item := multiProgress.Items[itemID]; item == nil {
		t.Fatal("expected item progress entry to exist")
	} else {
		if item.Status != itemProgressStatusPreparing {
			t.Fatalf("status = %q, want %q", item.Status, itemProgressStatusPreparing)
		}
		if item.Progress != 0 {
			t.Fatalf("progress = %v, want 0", item.Progress)
		}
	}

	SetItemProgress(itemID, 0.05, 0, 0)
	if item := multiProgress.Items[itemID]; item == nil {
		t.Fatal("expected item progress entry to exist after update")
	} else if item.Status != itemProgressStatusPreparing {
		t.Fatalf("status after synthetic pre-download progress = %q, want %q", item.Status, itemProgressStatusPreparing)
	} else if item.Progress != 0 {
		t.Fatalf("progress after synthetic pre-download progress = %v, want 0", item.Progress)
	}

	SetItemDownloading(itemID)
	if item := multiProgress.Items[itemID]; item == nil {
		t.Fatal("expected item progress entry to exist after downloading status")
	} else if item.Status != itemProgressStatusDownloading {
		t.Fatalf("status after download start = %q, want %q", item.Status, itemProgressStatusDownloading)
	}

	SetItemProgress(itemID, 0.37, 0, 0)
	if item := multiProgress.Items[itemID]; item == nil {
		t.Fatal("expected item progress entry to exist after real update")
	} else if item.Status != itemProgressStatusDownloading {
		t.Fatalf("status after real progress update = %q, want %q", item.Status, itemProgressStatusDownloading)
	} else if item.Progress != 0.37 {
		t.Fatalf("progress after real update = %v, want 0.37", item.Progress)
	}
}

func TestItemProgressPreparationStageIsObservable(t *testing.T) {
	ClearAllItemProgress()
	defer ClearAllItemProgress()

	itemID := "stage-item"
	StartItemProgress(itemID)
	SetItemPreparingStage(itemID, "resolving_metadata")

	var progress ItemProgress
	if err := json.Unmarshal([]byte(GetItemProgress(itemID)), &progress); err != nil {
		t.Fatalf("decode progress: %v", err)
	}
	if progress.Status != itemProgressStatusPreparing || progress.Stage != "resolving_metadata" {
		t.Fatalf("unexpected preparation progress: %#v", progress)
	}

	SetItemDownloading(itemID)
	progress = ItemProgress{}
	if err := json.Unmarshal([]byte(GetItemProgress(itemID)), &progress); err != nil {
		t.Fatalf("decode downloading progress: %v", err)
	}
	if progress.Stage != "" {
		t.Fatalf("download stage was not cleared: %#v", progress)
	}
}

func TestItemProgressFinalizingAndCompletedStatuses(t *testing.T) {
	const itemID = "progress-finalizing-item"
	RemoveItemProgress(itemID)
	defer RemoveItemProgress(itemID)

	StartItemProgress(itemID)
	SetItemFinalizing(itemID)

	if item := multiProgress.Items[itemID]; item == nil {
		t.Fatal("expected item progress entry to exist")
	} else if item.Status != itemProgressStatusFinalizing {
		t.Fatalf("status = %q, want %q", item.Status, itemProgressStatusFinalizing)
	}

	CompleteItemProgress(itemID)
	if item := multiProgress.Items[itemID]; item == nil {
		t.Fatal("expected item progress entry to exist after completion")
	} else if item.Status != itemProgressStatusCompleted {
		t.Fatalf("status = %q, want %q", item.Status, itemProgressStatusCompleted)
	}
}

func TestMultiProgressDeltaResetChangedAndRemoved(t *testing.T) {
	ClearAllItemProgress()
	defer ClearAllItemProgress()

	StartItemProgress("item-a")
	SetItemBytesTotal("item-a", 1000)

	var initial MultiProgressDelta
	if err := json.Unmarshal([]byte(GetMultiProgressDelta(0)), &initial); err != nil {
		t.Fatalf("initial delta parse failed: %v", err)
	}
	if !initial.Reset {
		t.Fatal("initial delta should reset")
	}
	if initial.Seq <= 0 {
		t.Fatalf("initial seq = %d, want > 0", initial.Seq)
	}
	if _, ok := initial.Items["item-a"]; !ok {
		t.Fatal("initial delta missing item-a")
	}

	if delta := GetMultiProgressDelta(initial.Seq); delta != "" {
		t.Fatalf("delta after same seq = %q, want empty", delta)
	}

	SetItemBytesReceivedWithSpeed("item-a", 256*1024, 2.5)
	var changed MultiProgressDelta
	if err := json.Unmarshal([]byte(GetMultiProgressDelta(initial.Seq)), &changed); err != nil {
		t.Fatalf("changed delta parse failed: %v", err)
	}
	if changed.Reset {
		t.Fatal("changed delta should not reset")
	}
	if _, ok := changed.Items["item-a"]; !ok {
		t.Fatal("changed delta missing item-a")
	}

	RemoveItemProgress("item-a")
	var removed MultiProgressDelta
	if err := json.Unmarshal([]byte(GetMultiProgressDelta(changed.Seq)), &removed); err != nil {
		t.Fatalf("removed delta parse failed: %v", err)
	}
	if len(removed.Removed) != 1 || removed.Removed[0] != "item-a" {
		t.Fatalf("removed = %#v, want item-a", removed.Removed)
	}
}
