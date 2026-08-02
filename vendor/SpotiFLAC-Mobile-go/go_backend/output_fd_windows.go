//go:build windows

package gobackend

func dupOutputFD(fd int) (int, error) {
	// Windows build is primarily for local tooling/tests.
	// Android runtime uses the !windows implementation.
	return fd, nil
}

func truncateFD(_ int) error {
	return nil
}

func seekFDStart(_ int) error {
	return nil
}

func closeFD(_ int) error {
	return nil
}

func isBestEffortTruncateError(_ error) bool {
	return true
}

func isBadFD(_ error) bool {
	return false
}
