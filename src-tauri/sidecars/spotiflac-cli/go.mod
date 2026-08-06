module github.com/nishal21/nekobeat/spotiflac-cli

go 1.26.5

require github.com/zarz/spotiflac_android/go_backend v0.0.0

require (
	github.com/andybalholm/brotli v1.2.2 // indirect
	github.com/dlclark/regexp2/v2 v2.5.2 // indirect
	github.com/dop251/goja v0.0.0-20260723142020-b4aef50fa347 // indirect
	github.com/go-flac/flacpicture/v2 v2.0.2 // indirect
	github.com/go-flac/flacvorbis/v2 v2.0.2 // indirect
	github.com/go-flac/go-flac/v2 v2.0.4 // indirect
	github.com/go-sourcemap/sourcemap v2.1.4+incompatible // indirect
	github.com/google/pprof v0.0.0-20260709232956-b9395ee17fa0 // indirect
	github.com/klauspost/compress v1.19.1 // indirect
	github.com/refraction-networking/utls v1.8.2 // indirect
	golang.org/x/crypto v0.54.0 // indirect
	golang.org/x/mobile v0.0.0-20260730202154-c700fe717e6e // indirect
	golang.org/x/mod v0.38.0 // indirect
	golang.org/x/net v0.57.0 // indirect
	golang.org/x/sync v0.22.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
	golang.org/x/text v0.40.0 // indirect
	golang.org/x/tools v0.48.0 // indirect
)

replace github.com/zarz/spotiflac_android/go_backend => ../../../vendor/SpotiFLAC-Mobile-go/go_backend
