# SpotiFLAC-Mobile go_backend (MIT) — vendored for NekoBeat Android

Upstream: https://github.com/spotiflacapp/SpotiFLAC-Mobile  
Pinned commit: see `UPSTREAM_COMMIT.txt`  
License: `LICENSE` (MIT) — retain copyright notices.

## Build AAR

Requires Go ≥ version in `go_backend/go.mod`, `ANDROID_NDK_HOME`, `CGO_ENABLED=1`:

```bash
# from nekobeat/
bash scripts/build-gobackend-aar.sh
# → src-tauri/gen/android/app/libs/gobackend.aar
NEKOBEAT_ENABLE_GOBACKEND=1 npm run tauri:android:build
```

CI sets `NEKOBEAT_ENABLE_GOBACKEND=1`. The AAR loads only in process `:spotiflac`
(`SpotiFlacService`); the main Tauri/GStreamer process never loads `libgojni`.

## Re-sync

```bash
git clone --depth 1 https://github.com/spotiflacapp/SpotiFLAC-Mobile.git /tmp/sfm
rsync -a --delete /tmp/sfm/go_backend/ vendor/SpotiFLAC-Mobile-go/go_backend/
cp /tmp/sfm/LICENSE vendor/SpotiFLAC-Mobile-go/LICENSE
git -C /tmp/sfm rev-parse HEAD > vendor/SpotiFLAC-Mobile-go/UPSTREAM_COMMIT.txt
```

Default extension registry used at runtime:

`https://raw.githubusercontent.com/spotiflacapp/SpotiFLAC-Extension/main/registry.json`

Override with env `NEKOBEAT_SPOTIFLAC_EXT_REGISTRY`.
