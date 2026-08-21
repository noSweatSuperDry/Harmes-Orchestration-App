# Hermes Orchestrator

Desktop control panel for the [Hermes](https://example.invalid) AI harness running on several VPS hosts.
Click a host, see and edit its Hermes profile, and drop into a live shell — no `ssh` + `vim` round trip.

## Run

```bash
npm install
npm start
```

## What it does

| Tab | Backed by | Notes |
| --- | --- | --- |
| **Overview** | `hermes --version`, `hermes profile`, `hermes auth list`, `uptime`, `df` | Read-only probes, each with a 10s timeout |
| **Model** | `config.yaml` | `model.default` / `model.provider` as first-class fields, every other scalar key in a flat editable table |
| **API Keys** | `.env` | Masked values, reveal toggle, add/remove; rewritten in place at mode `600` |
| **Memory** | `memories/MEMORY.md`, `memories/USER.md`, `SOUL.md` | Plain editors; Hermes snapshots memory at session start |
| **Raw config** | `config.yaml` | Full YAML editor, validated before it is written |
| **Terminal** | SSH PTY | Real `xterm.js` shell per host, kept alive while you switch tabs |

Each host is independent — its own connection, profile selection, and settings.

## How it talks to the VPS

- `ssh2` over your existing key (`~/.ssh/id_ed25519` by default) and `ssh-agent` if `SSH_AUTH_SOCK` is set.
  A passphrase-protected key prompts once per connection; the passphrase is never written to disk.
- Config files are read and written over **SFTP**. `config.yaml` edits go through the YAML
  document API, so comments and formatting survive a save.
- CLI probes run as `bash -lc '…'` so `hermes` is on `PATH`.
- The Hermes home is resolved the documented way: `${HERMES_HOME:-$HOME/.hermes}`, with named
  profiles at `<home>/profiles/<name>`. A per-host override is available in the host editor.

## Building installers

```bash
npm run dist:mac    # release/*.dmg  — arm64 + x64, ad-hoc signed
npm run dist:win    # release/*.exe  — NSIS installer, x64
```

Output lands in `release/`. Verified working: both DMGs pass `hdiutil verify` and the packaged
app launches with xterm resolving from inside the asar.

### Windows from a Mac

`electron-builder` needs Wine to stamp icons and version info into the `.exe`, so `npm run dist:win`
will not work on this machine as-is. In order of preference:

1. **CI** — push a `v*` tag; `.github/workflows/build.yml` builds each target on its native runner
   and uploads both as artifacts. Nothing to install locally.
2. **Wine** — `brew install --cask wine-stable`, then `npm run dist:win`.
3. **A Windows machine** — `npm ci && npm run dist:win`.

### Signing

`dist:mac` sets `CSC_IDENTITY_AUTO_DISCOVERY=false` deliberately. Without it, electron-builder
grabs whatever certificate is in your keychain — and an *Apple Development* cert is not valid for
distribution, so `spctl` rejects the result while the build still reports success. Ad-hoc signing
is the honest default.

To sign for real, use `npm run dist:mac:signed` with a **Developer ID Application** certificate
(Apple Developer Program, $99/yr) plus notarization credentials. Without that:

- **macOS** — *"can't be opened because it is from an unidentified developer"*.
  Right-click the app → **Open** → **Open**, once per machine.
- **Windows** — SmartScreen *"Windows protected your PC"* → **More info** → **Run anyway**.
  Silencing it needs an EV code-signing certificate.

### Native modules

`npmRebuild` is off and two optional native deps are excluded from packaged builds:

- `ssh2`'s crypto accelerator — compiled for whichever platform ran `npm install`; shipping a
  darwin `.node` into a Windows installer is worse than the pure-JS path ssh2 falls back to.
- `cpu-features` — `ssh2` requires it inside a `try/catch`, and building it fails on Python 3.12+
  anyway (`node-gyp` still imports the removed `distutils`).

### Note on settings location

Dev mode (`npm start`) and the packaged app use **different** userData directories
(`hermes-orchestrator` vs `Hermes Orchestrator`), so hosts added while developing will not appear
in the installed app.

## Host storage

Hosts live in `hosts.json` under Electron's `userData` dir, written `0600`. It holds hostnames,
users, and key *paths* — no secrets.

## Known gaps

- Profile switching drives **file editing** only. The Overview probes and the terminal run plain
  `hermes` against whatever profile is active on the host, because the CLI's profile flag isn't
  confirmed. Once you tell me the flag (or env var), both hook up in one edit.
- `auth.json` is read-only — it lists credential names and expiry, never token values.
- Host-key verification is currently accept-on-connect.
