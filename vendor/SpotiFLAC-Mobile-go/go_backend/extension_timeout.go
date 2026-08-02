package gobackend

import (
	"context"
	"fmt"
	"runtime/debug"
	"sync"
	"time"

	"github.com/dop251/goja"
)

type JSExecutionError struct {
	Message       string
	IsTimeout     bool
	RuntimeUnsafe bool
	Cause         error
}

func (e *JSExecutionError) Error() string {
	return e.Message
}

func (e *JSExecutionError) Unwrap() error {
	return e.Cause
}

var jsInterruptGracePeriod = 5 * time.Second

func RunWithTimeoutContext(ctx context.Context, vm *goja.Runtime, script string, timeout time.Duration) (goja.Value, error) {
	return runGojaCallWithTimeoutContext(ctx, vm, func() (goja.Value, error) {
		return vm.RunString(script)
	}, timeout)
}

func runGojaCallWithTimeoutContext(ctx context.Context, vm *goja.Runtime, call func() (goja.Value, error), timeout time.Duration) (goja.Value, error) {
	if vm == nil {
		return nil, fmt.Errorf("extension runtime unavailable")
	}
	if call == nil {
		return nil, fmt.Errorf("extension call unavailable")
	}

	if timeout <= 0 {
		timeout = DefaultJSTimeout
	}

	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	type result struct {
		value goja.Value
		err   error
	}
	resultCh := make(chan result, 1)

	var interrupted bool
	var interruptMu sync.Mutex

	go func() {
		defer func() {
			if r := recover(); r != nil {
				interruptMu.Lock()
				wasInterrupted := interrupted
				interruptMu.Unlock()

				if wasInterrupted {
					resultCh <- result{nil, &JSExecutionError{
						Message:   "execution timeout exceeded",
						IsTimeout: true,
					}}
				} else {
					GoLog("[extensionRuntime] panic during JS execution: %v\n%s\n", r, string(debug.Stack()))
					resultCh <- result{nil, fmt.Errorf("panic during execution: %v", r)}
				}
			}
		}()

		val, err := call()
		resultCh <- result{val, err}
	}()

	select {
	case res := <-resultCh:
		return res.value, res.err
	case <-ctx.Done():
		cancelled := ctx.Err() == context.Canceled
		interruptMu.Lock()
		interrupted = true
		interruptMu.Unlock()

		if cancelled {
			vm.Interrupt("extension request cancelled")
		} else {
			vm.Interrupt("execution timeout")
		}

		// MUST wait for the goroutine to finish before returning.
		// The Goja VM is NOT thread-safe — if we return while the goroutine
		// is still executing JS (e.g. blocked on an HTTP call), the next
		// caller will access the VM concurrently and crash with a nil
		// pointer dereference.
		select {
		case <-resultCh:
			if cancelled {
				return nil, ErrExtensionRequestCancelled
			}
			return nil, &JSExecutionError{
				Message:   "execution timeout exceeded",
				IsTimeout: true,
			}
		case <-time.After(jsInterruptGracePeriod):
			// Goroutine is truly stuck (e.g. HTTP read with no timeout).
			// Log a warning — the VM should NOT be reused after this.
			GoLog("[extensionRuntime] WARNING: JS goroutine did not exit within 60s after interrupt, VM may be unsafe\n")
			message := "execution timeout exceeded (runtime quarantined)"
			var cause error
			if cancelled {
				message = "extension request cancelled (runtime quarantined)"
				cause = ErrExtensionRequestCancelled
			}
			return nil, &JSExecutionError{
				Message:       message,
				IsTimeout:     !cancelled,
				RuntimeUnsafe: true,
				Cause:         cause,
			}
		}
	}
}

// RunWithTimeoutAndRecover runs JS with timeout and clears interrupt state after
// This should be used when you want to continue using the VM after a timeout
func RunWithTimeoutAndRecover(vm *goja.Runtime, script string, timeout time.Duration) (goja.Value, error) {
	return RunWithTimeoutContextAndRecover(context.Background(), vm, script, timeout)
}

func RunWithTimeoutContextAndRecover(ctx context.Context, vm *goja.Runtime, script string, timeout time.Duration) (goja.Value, error) {
	result, err := RunWithTimeoutContext(ctx, vm, script, timeout)

	if vm != nil && !IsRuntimeUnsafeError(err) {
		vm.ClearInterrupt()
	}

	return result, err
}

func runGojaCallWithTimeoutAndRecover(vm *goja.Runtime, call func() (goja.Value, error), timeout time.Duration) (goja.Value, error) {
	return runGojaCallWithTimeoutContextAndRecover(context.Background(), vm, call, timeout)
}

func runGojaCallWithTimeoutContextAndRecover(ctx context.Context, vm *goja.Runtime, call func() (goja.Value, error), timeout time.Duration) (goja.Value, error) {
	result, err := runGojaCallWithTimeoutContext(ctx, vm, call, timeout)

	if vm != nil && !IsRuntimeUnsafeError(err) {
		vm.ClearInterrupt()
	}

	return result, err
}

func IsRuntimeUnsafeError(err error) bool {
	jsErr, ok := err.(*JSExecutionError)
	return ok && jsErr.RuntimeUnsafe
}

func IsTimeoutError(err error) bool {
	if jsErr, ok := err.(*JSExecutionError); ok {
		return jsErr.IsTimeout
	}
	return false
}
