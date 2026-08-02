//go:build !windows

package gobackend

import "syscall"

func dupOutputFD(fd int) (int, error) {
	return syscall.Dup(fd)
}

func truncateFD(fd int) error {
	return syscall.Ftruncate(fd, 0)
}

func seekFDStart(fd int) error {
	_, err := syscall.Seek(fd, 0, 0)
	return err
}

func closeFD(fd int) error {
	return syscall.Close(fd)
}

func isBestEffortTruncateError(err error) bool {
	switch err {
	case syscall.EPERM, syscall.EACCES, syscall.EINVAL, syscall.ESPIPE, syscall.ENOSYS:
		return true
	default:
		return false
	}
}

func isBadFD(err error) bool {
	return err == syscall.EBADF
}
