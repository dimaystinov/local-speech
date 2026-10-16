#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node tools/build-sdk.cjs --models=small,whisper_tiny,whisper
node tools/build-speaker-assets.cjs "${@}"
swift build -c release --package-path apps/mac
app_path="$PWD/apps/mac/dist/LocalSpeech Calls.app"
mkdir -p "$app_path/Contents/MacOS" "$app_path/Contents/Resources/Web"
cp apps/mac/.build/release/CallScribe "$app_path/Contents/MacOS/CallScribe"
cp tools/word-confidence.py "$app_path/Contents/Resources/"
cp apps/mac/Assets/roki-assistant.png "$app_path/Contents/Resources/"
mkdir -p "$app_path/Contents/Resources/RokiVoice"
cp apps/mac/Assets/RokiVoice/profile.json apps/mac/Assets/RokiVoice/reference.wav apps/mac/Assets/RokiVoice/synthesize.py apps/mac/Assets/RokiVoice/stream.py "$app_path/Contents/Resources/RokiVoice/"
cp apps/mac/Web/bridge.html apps/mac/Web/bridge.js apps/mac/Web/speakers.js "$app_path/Contents/Resources/Web/"
# Optional pinned native second pass. The runtime and weights are bundled once.
if [ -n "${LOCALSPEECH_SHERPA_DIR:-}" ]; then
  python3 tools/build-native-refiner.py --sherpa-dir="$LOCALSPEECH_SHERPA_DIR" --models-root="${LOCALSPEECH_MODELS_ROOT:-$PWD/models}" --out="$app_path/Contents/Resources/NativeASR"
fi

if [ -d "$app_path/Contents/Resources/Web/sdk" ]; then
  mv "$app_path/Contents/Resources/Web/sdk" "$app_path/Contents/Resources/Web/sdk.previous"
fi
cp -R dist/local-speech "$app_path/Contents/Resources/Web/sdk"
if [ -d "$app_path/Contents/Resources/Web/sdk.previous" ]; then
  rm -r "$app_path/Contents/Resources/Web/sdk.previous"
fi
cat > "$app_path/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>CallScribe</string>
<key>CFBundleIdentifier</key><string>io.localspeech.calls</string>
<key>CFBundleName</key><string>LocalSpeech Calls</string>
<key>CFBundleDisplayName</key><string>LocalSpeech Calls</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.2.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>26.0</string>
<key>NSMicrophoneUsageDescription</key><string>Ваш голос нужен для локальной расшифровки созвона нашим SDK.</string>
<key>NSAudioCaptureUsageDescription</key><string>Звук выбранного приложения нужен для локальной расшифровки собеседников.</string>
<key>NSCalendarsFullAccessUsageDescription</key><string>Роки читает названия и время событий, чтобы напоминать о вашем графике. События не изменяются и не отправляются на сервер.</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
codesign --force --sign - "$app_path"
echo "$app_path"
