# SDK releases and updating from GitHub

`package.json` is the version source. The builder embeds it into `LocalSpeech.version`,
`diagnostics().version`, the bundle header and `package-manifest.json`.

## Install or update a host application

Requires Node.js 22+ for installation. Recognition still runs in the browser.

```sh
npm install --save-exact github:dimaystinov/local-speech#v0.3.0
```

Commit the host application's package-lock.json. For an update, replace the tag with
the desired released version and run the same command. Roll back by installing the
previous tag. Do not use `#main` in production. Review the changelog before a minor
upgrade while the SDK is pre-1.0. `npm update` does not automatically advance pinned tags.

Git installation prepares a runtime-only SDK without downloading weights. Copy the
**entire** `node_modules/local-speech-sdk/dist/local-speech/` directory into a new
versioned directory on your application origin, for example `/speech/0.3.0/`.
Point script URLs and `assetBaseURL` to that directory. Do not bundle only the JS file:
workers, WASM and manifests must remain together. This is a browser SDK, not a Node ASR API.

Models are installed separately from the pinned manifest:

```sh
cd node_modules/local-speech-sdk
python3 tools/download-models.py --models small whisper_tiny whisper
```

Copy the resulting `models/` into the deployed versioned SDK directory. Downloaded
weights are hash-verified; existing matching local files are reused. Browser caches
may be evicted and versioned paths can cause a fresh cache fill. Runtime-only release
archives do not contain model weights. No audio is sent to GitHub.

Test the new directory, then switch your application's asset URL on the next session
or page reload. Keep the prior directory available for rollback. Never swap workers
or WASM underneath an active call. There is deliberately no silent runtime code update.

Alternatively download `local-speech-sdk-VERSION.tgz` and `SHA256SUMS` from GitHub
Releases, verify the checksum and extract the archive (`package/dist/local-speech/`).
Checksums detect corruption; trust in the publisher still depends on GitHub/release access.

## Publish the next version

```sh
npm version patch --no-git-tag-version
# Or: npm version minor --no-git-tag-version
# Add a matching entry in CHANGELOG.md, then:
npm test
npm run prepare
npm run release:check
git add package.json package-lock.json CHANGELOG.md
git commit -m "Release SDK VERSION"
git tag -a vVERSION -m "LocalSpeech SDK VERSION"
git push origin main
git push origin vVERSION
```

The tag workflow checks version/changelog, runs JS/Python and macOS Swift tests,
builds the runtime-only npm archive and publishes a GitHub Release with SHA-256.
No npm registry account or token is required. Failed tests prevent publishing.
SDK releases do not install or auto-update the macOS application; build that separately.
User recordings, personal voice profiles, model weights and local benchmark data
are excluded from Git. The original synthetic Roki reference voice is included,
with its provenance and hash in `apps/mac/Assets/RokiVoice/profile.json`.
Qwen requires a separate local runtime and model installation.
