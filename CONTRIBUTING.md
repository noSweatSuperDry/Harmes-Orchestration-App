# Contributing

Thanks for taking a look. This is a small, dependency-light Electron app — you should be able to
read the whole thing in an afternoon.

## Getting set up

```bash
npm install
npm start
```

You need a reachable machine over SSH to exercise most of it. There is no mock SSH server, so
a local VM, a container with `sshd`, or any box you already have keys for all work.

## Layout

```
electron/
  main.js         Window creation and every IPC handler
  preload.js      The contextBridge surface — the only thing the renderer can call
  ssh-manager.js  Connections, exec, SFTP, PTY streams
  hermes.js       Hermes-specific reads and writes (config.yaml, .env, memories)
  telemetry.js    The remote probe script and its parsers
  store.js        config.json, defaults, ~/.ssh/config import
  credentials.js  Passwords, encrypted via OS keychain (safeStorage)
renderer/
  index.html      Static shell — panes and modals
  app.js          All rendering and state
  styles.css      Everything visual, including the agent animations
```

There is no bundler and no framework. The renderer is plain DOM built with a small `el()` helper.
Keep it that way unless there is a strong reason not to.

## Ground rules

**Security posture.** `contextIsolation` is on, `nodeIntegration` is off, and the renderer talks to
Node only through `preload.js`. Do not widen that surface without a good reason. Never log, persist,
or send anywhere the contents of `.env`, `auth.json`, a private key, or an SSH password.

**Secrets never enter `config.json`.** That file is documented as safe to read and hand-edit.
Passwords go through `credentials.js` and `safeStorage` only; a host record may record *that* a
password was saved, never the value. There is no code path that returns a stored password to the
renderer — it is read in the main process and handed straight to `ssh2`.

**Remote commands run through `bash -lc`** so `hermes` is on `PATH`. Anything interpolated into a
command must go through `ssh.shq()`.

**Config writes must be non-destructive.** `config.yaml` edits go through the YAML document API so
comments and formatting survive; `.env` is rewritten line-by-line rather than regenerated. If you
add a new file editor, follow that pattern.

**Telemetry parsers should degrade, not throw.** A missing `docker`, an unreadable `/proc` entry, or
a BSD host should produce an empty or clearly-labelled panel — never a crash or a blank screen.

## Testing a change

There is no test suite yet. What is expected instead:

- `node --check` every file you touched.
- Run the app and confirm the terminal you launched from stays silent — renderer errors are relayed
  there, tagged `[renderer]`.
- If you touched a parser, exercise it against fixture text rather than only against your own
  server. Stub `ssh.exec` and feed it sample output; that is how the current parsers were verified.
- If you touched authentication, test against a real server. `ssh2` ships a `Server` class — spin
  one up on localhost with a throwaway host key and assert both the accept and reject paths, plus
  `keyboard-interactive`. That is how password auth was verified.
- If you touched layout, check it at a narrow window width. A pane must never scroll horizontally.

A PR that adds a real test harness would be very welcome.

## Things worth doing

- **Host-key verification.** Connections are currently accept-on-connect, with no `known_hosts`
  check. This is the most valuable thing anyone could fix.
- **Non-Linux telemetry.** The probes assume `/proc`. BSD and macOS hosts report zeros.
- **Profile-aware CLI calls.** Profile switching drives file editing only; the Overview probes and
  terminal run plain `hermes` against whatever profile is active on the host, because the CLI's
  profile flag is unconfirmed.
- **Windows and Linux testing.** Developed on macOS. The Windows installer builds in CI but has had
  no real use.

## Commits and PRs

Conventional-ish subject lines (`fix:`, `feat:`, `docs:`) are appreciated but not enforced.
Describe what you changed and how you convinced yourself it works.
