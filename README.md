# Hermes Orchestrator

Desktop control panel for the Hermes AI harness running across several VPS hosts.
Click a host, see and edit its Hermes profile, watch what the agent is doing, and drop into a live
shell — no `ssh` + `vim` round trip.

Built with Electron and `ssh2`. Everything happens over your existing SSH key; there is no server,
no telemetry, and no account.

## Quick start

```bash
git clone <your-fork-url> && cd hermes-orchestrator
npm install
npm start
```

On first launch, open **Settings** (bottom of the sidebar) and set your SSH username and key path,
then add a host — or hit **Scan and import** to pull every machine out of your `~/.ssh/config`.

## Configuration

Hosts and defaults live in a plain JSON file you can read, edit, back up, and copy between machines:

```
~/.hermes-orchestrator/config.json
```

Point it elsewhere with `HERMES_ORCHESTRATOR_CONFIG=/path/to/config.json`. See
[`config.example.json`](config.example.json) for the full shape:

```jsonc
{
  "defaults": {
    "username": "your-ssh-user",
    "privateKeyPath": "~/.ssh/id_ed25519",
    "port": 22,
    "profile": "default",
    "hermesHome": ""
  },
  "ui": { "motion": "always" },
  "hosts": [
    {
      "id": "prod-1",
      "label": "Production",
      "hostname": "prod.example.com",
      "port": 22,
      "username": "your-ssh-user",
      "privateKeyPath": "~/.ssh/id_ed25519",
      "hermesHome": "",
      "defaultProfile": "default"
    }
  ]
}
```

Edit it by hand or through **Settings** — the two stay in sync, and **Reload from disk** picks up
external edits without restarting. `~` is expanded in key paths. The file is written `0600` inside
a `0700` directory.

> **It stores the *path* to your private key, never the key itself.** It does still name your
> servers, so keep it out of public repos — the shipped `.gitignore` already excludes `config.json`.

### Settings

| Section | What it does |
| --- | --- |
| **Connection defaults** | Username, port, key path, Hermes profile and home — pre-filled for every new host |
| **Appearance** | Agent animation: `Always on` / `Follow system` / `Off` |
| **Config file** | Shows the path, reveals it in your file manager, reloads it from disk |
| **Import** | Adds a host per `Host` entry in `~/.ssh/config`, skipping wildcards and duplicates |

## What it does

| Tab | Backed by | Notes |
| --- | --- | --- |
| **Overview** | `hermes --version`, `hermes profile`, `hermes auth list`, `uptime`, `df` | Read-only probes, each with a 10s timeout |
| **Telemetry** | `/proc`, `df`, `ps`, `docker`, port probes | CPU/memory/disk/network, top processes, Docker, Supabase health. Auto-refreshes every 5s |
| **Model** | `config.yaml` | `model.default` / `model.provider` as first-class fields, every other scalar key in a flat editable table |
| **API Keys** | `.env` | Masked values, reveal toggle, add/remove; rewritten in place at mode `600` |
| **Memory** | `memories/MEMORY.md`, `memories/USER.md`, `SOUL.md` | Plain editors; Hermes snapshots memory at session start |
| **Raw config** | `config.yaml` | Full YAML editor, validated before it is written |
| **Terminal** | SSH PTY | Real `xterm.js` shell per host, kept alive while you switch tabs |

Each host is independent — its own connection, profile selection, and settings.

### Agent activity

Every host shows an animated avatar reflecting what Hermes is actually doing. The state is derived,
never faked — from the remote process table (`ps | grep hermes`, polled every 4s) plus live PTY
output:

| State | Meaning | Animation |
| --- | --- | --- |
| **Offline** | not connected | static, dimmed |
| **Sleeping** | no `hermes` process on the host | slow breathing + drifting `z`s |
| **Idle** | process alive, under 1.5% CPU | gentle pulse with halo |
| **Thinking** | 1.5–15% CPU | three bobbing dots |
| **Working** | over 15% CPU, or bytes streaming to the terminal | spinning arc + fast throb |

Terminal output wins over the CPU poll: if bytes are arriving, the agent is demonstrably busy and
flips to **Working** within a frame rather than waiting up to 4s for the next poll.

Animation is controlled in **Settings → Appearance** (`Always on` / `Follow system` / `Off`). It
defaults to **Always on** — note that this overrides your OS "Reduce motion" accessibility setting
(macOS: System Settings → Accessibility → Display). Choose **Follow system** to respect it.

### Telemetry

One SSH round trip per refresh gathers everything, sampling CPU and network counters twice 600ms
apart to compute real rates rather than cumulative totals:

- **System** — distro, kernel, uptime, 1/5/15m load, core count
- **CPU & memory** — CPU% from `/proc/stat` deltas; memory and swap from `/proc/meminfo`
- **Network** — per-interface up/down rates and lifetime totals; virtual interfaces (`lo`,
  `docker*`, `veth*`, `br-*`) are flagged and excluded from the headline figures
- **Storage** — every real filesystem, with tmpfs/overlay/squashfs filtered out
- **Processes** — top 20 by CPU, plus a dedicated Hermes process table
- **Docker** — containers, images, and `system df`. Degrades with a specific reason
  (*permission denied*, *daemon not running*, *not installed*) rather than an empty panel
- **Supabase** — detected three ways: container names, the `supabase` CLI, and HTTP probes of
  ports 54321–54324/8000/3000. Reports `healthy` / `degraded` / `not detected`

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for layout, ground rules, and the list of things most worth
doing — host-key verification being the big one.

## License

[MIT](LICENSE)
