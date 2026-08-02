package gobackend

import (
	"fmt"
	"os"
	"strings"
)

func isFDOutput(outputFD int) bool {
	return outputFD > 0
}

func openOutputForWrite(outputPath string, outputFD int) (*os.File, error) {
	if isFDOutput(outputFD) {
		// Never hand the original detached FD directly to a provider attempt.
		// Fallback chains may retry with another provider after a failure.
		// If the first attempt closes the original FD, its numeric ID can be
		// reused by unrelated resources and a later close may trigger fdsan abort.
		dupFD, err := dupOutputFD(outputFD)
		if err != nil {
			return nil, fmt.Errorf("failed to duplicate output fd %d: %w", outputFD, err)
		}
		if err := prepareDupFDForWrite(dupFD, outputFD); err != nil {
			_ = closeFD(dupFD)
			return nil, err
		}
		return os.NewFile(uintptr(dupFD), fmt.Sprintf("saf_fd_%d_dup_%d", outputFD, dupFD)), nil
	}

	path := strings.TrimSpace(outputPath)
	if strings.HasPrefix(path, "/proc/self/fd/") {
		// Re-open procfs fd path instead of taking ownership of raw detached fd.
		// Some SAF providers reject O_TRUNC on these descriptors with EACCES/EPERM.
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_TRUNC, 0)
		if err == nil {
			return file, nil
		}
		if os.IsPermission(err) {
			return os.OpenFile(path, os.O_WRONLY, 0)
		}
		return nil, err
	}

	return os.Create(outputPath)
}

func prepareDupFDForWrite(dupFD, originalFD int) error {
	// Best-effort reset so retries start writing from byte 0.
	if err := truncateFD(dupFD); err != nil {
		if isBestEffortTruncateError(err) {
			GoLog("[OutputFD] truncate not supported on fd %d (dup of %d): %v\n", dupFD, originalFD, err)
		} else {
			return fmt.Errorf("failed to truncate output fd %d (dup of %d): %w", dupFD, originalFD, err)
		}
	}
	if err := seekFDStart(dupFD); err != nil {
		GoLog("[OutputFD] seek reset failed on fd %d (dup of %d): %v\n", dupFD, originalFD, err)
	}
	return nil
}

func closeOwnedOutputFD(outputFD int) {
	if !isFDOutput(outputFD) {
		return
	}

	if err := closeFD(outputFD); err != nil {
		if !isBadFD(err) {
			GoLog("[OutputFD] failed to close detached fd %d: %v\n", outputFD, err)
		}
		return
	}

	GoLog("[OutputFD] closed detached fd %d\n", outputFD)
}

func cleanupOutputOnError(outputPath string, outputFD int) {
	if isFDOutput(outputFD) {
		return
	}

	path := strings.TrimSpace(outputPath)
	if path == "" || strings.HasPrefix(path, "/proc/self/fd/") {
		return
	}

	_ = os.Remove(path)
}
