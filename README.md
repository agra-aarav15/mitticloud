<div align="center">

# 🏺 MittiCloud

**Your drawer-phone is a cloud now.**

A free personal cloud — photo vault, file server, websites, live Node apps, and a
real SSH door for plain SSH clients — that runs on an old Android phone or a
small VPS. No subscriptions. No paid server. Your files stay where you put them.

*mitti* = soil in Hindi. Your cloud grows at home.

![License](https://img.shields.io/badge/License-AGPL--3.0-blue)
![Node](https://img.shields.io/badge/Node-%3E%3D_20-339933)
![APK](https://img.shields.io/badge/Android-APK-3DDC84)
![Release](https://img.shields.io/badge/release-v0.19.2-orange)
![PRs](https://img.shields.io/badge/PRs-welcome-brightgreen)

</div>

---

## Install — pick one

### 1 · Android APK (no commands)

1. Open the [latest release](https://github.com/agra-aarav15/mitticloud/releases/latest) and download `MittiCloud-v*.apk`.
2. Tap it. Android asks once to allow the install from this source — allow it.
3. Open **MittiCloud**, tap **Start MittiCloud 24/7**. A notification appears: *MittiCloud is running 24/7 on this phone.* That notification is the lock — it keeps the server awake.
4. Tap **Keep it awake: allow unrestricted battery** and choose **Unrestricted**.

The dashboard opens inside the app. Keep the phone plugged in for long runs.

### 2 · A VPS, with one line

```bash
curl -fsSL https://raw.githubusercontent.com/agra-aarav15/mitticloud/main/scripts/vps-install.sh | sudo bash
```

It installs Node 20, creates a `mitti` user, clones MittiCloud into `/opt/mitticloud`, and runs it as a systemd service that restarts on failure. Open `http://<your-server-ip>:7333`. Re-running the line is safe.

The web app and its APIs are open on your network — they need no token. The one secret is the SSH password (see the SSH note below).

### 3 · Termux on an old phone

1. Install **Termux** and **Termux:Boot** from [F-Droid](https://f-droid.org) (not the Play Store builds).
2. In Termux:
   ```bash
   git clone https://github.com/agra-aarav15/mitticloud.git mitticloud && cd mitticloud
   bash scripts/install.sh
   npm start
   ```
3. Open `http://localhost:7333` on the phone, or `http://<phone-ip>:7333` on the same Wi-Fi.

Full walkthrough with battery settings: [docs/PHONE-SETUP.md](docs/PHONE-SETUP.md).

---

## What you get in v0.19.2

- **The agent stops crash-looping: embedded children get a writable TMPDIR.** v0.19.1 got the agent spawning — and ZCode's log showed it immediately dying 114 times in 10 minutes on `listen EACCES /tmp/znr-*.sock`. There is no `/tmp` on Android, so `os.tmpdir()` falls back to the literal `/tmp`, which the app cannot write — and the agent's startup broker socket needs exactly that. SSH-spawned shells and hosted apps on the phone now get `TMPDIR=data/tmp` (created app-private; an explicitly set TMPDIR is respected). Desktops are untouched.
  - **The Intl stand-in is callable without `new`, like the real one.** The client's config reader calls `Intl.DateTimeFormat(...)` as a plain function; the old class-based stand-in threw `cannot be invoked without 'new'`. Both stand-ins are functions now and return a fresh instance when called that way.
  - **Honest limits, unchanged:** see v0.19.0 (in-memory sqlite, approximate Unicode ranges, local-time Intl, worker-reroute workaround).

## What you get in v0.19.1

- **The agent actually starts now — v0.19.0 fixed a crash the agent never got far enough to hit.** The screenshot showed `write EPIPE` still in Sync Plugins with v0.19.0 on the phone, and ZCode's own log named the real killer one line above it: `spawn …/server/agents/glm/zcode-agent EACCES`. The server does not spawn the agent bundle directly — it spawns a **deployed entry** (`agents/glm/zcode-agent`, a `#!/bin/sh` wrapper the desktop writes with no exec bit in the deploy path), and on Android spawning that vault file dies with EACCES. The v0.19.0 reroute only looked at spawn **arguments**, but the entry travels as the spawn **command** — so it never fired. The shim now matches the command itself: when the entry's sibling `zcode.cjs` bundle is present, the spawn is rewritten to run that bundle on the phone's own Node through the worker wrapper — the vault file is never execed, and the worker thread still sidesteps the arm64 main-thread SIGSEGV. Without the sibling bundle the spawn is left untouched, so a future layout fails honestly instead of silently.
  - **Why one dead process broke Sync Plugins:** with the agent unspawnable, every agent RPC — `sendConversationCommandV4`, `readWorkspacePresentation`, and the `getPluginsOverview` the sync dialog needs — dies writing to a dead pipe. That is the `write EPIPE`.
  - **Honest limits, unchanged:** in-memory sqlite, approximate Unicode ranges, local-time Intl — see v0.19.0. The agent's own children (search tools, terminals) are the next wall if they turn out to be Linux binaries Android cannot run; this release gets the agent itself booted.

## What you get in v0.19.0

- **ZCode's agent stopped crashing on the phone — and the reason turned out to be a Node version, not ICU.** v0.18.2 got ZCode's *server* through, but the session still died with `write EPIPE`, because ZCode runs a **second** process (the agent, `glm/zcode.cjs`, ~15 MB) and that one crashed too. Running the real bundle on the desktop, side by side, showed what it actually needs:

  | Runtime | Result on the same bundle |
  |---|---|
  | Node 18 (what the APK ships) | exits 0 with **zero** output |
  | Node 18 + the sqlite stand-in alone | still zero — dies at `crypto is not defined` |
  | Node 20 | real protocol output |
  | Node 22 | real protocol output |

  So the bundle is a **Node 20/22 program**. It requires three builtins Node 18 does not have: `node:sea` (Node 20.12), `node:sqlite` (Node 22.5), and `globalThis.crypto` (a global from Node 19 — Node 18 has WebCrypto, just not the global). The shim now closes all three, and the sqlite stand-in answers the **WAL handshake** the client insists on (`pragma journal_mode` must read back `wal`, or it aborts startup).
  - **A native crash remained on arm64 Android**, and it was isolated precisely: the bundle **SIGSEGVs on the main thread** (exit 139, every run) but **exits cleanly on a worker thread** — at 4 MB, 8 MB, 16 MB and 64 MB alike. So it is not a stack shortage (`--stack-size` and `ulimit -s` change nothing), and desktop x86-64 does not crash at all. The shim now runs the **agent** bundle on a worker thread, forwarding stdin/stdout/stderr and the exit code, so whoever spawned it sees an ordinary child.
  - **Scoped deliberately narrow, and verified on the phone:** only the agent is rerouted — never `zcode-server.cjs`, whose long-lived process would break the whole connection if it were moved onto a worker. On the device: agent `wouldRedirect=true`, server `wouldRedirect=false`, and a server-shaped spawn provably still runs on the main thread.
  - **Honest limits:** the `\p{...}` ranges are explicit approximations, not the real Unicode tables; the `Intl` stand-in formats in the phone's local time and cannot resolve an arbitrary IANA zone; and the `node:sqlite` stand-in is in memory, so ZCode's SQLite-backed task and automation history do not survive a restart. The worker reroute is a workaround for an arm64 Android fault we isolated but did not root-cause; desktop never needed it.

## What you get in v0.18.2

- **ZCode Remote really connects now — the phone's Node was missing three things, and v0.18.1 fixed only one.** v0.18.1 loaded a stand-in for `require("node:sqlite")`, which got rid of the first crash — but the session still died with "Stream closed before handshake completed" because ZCode's server needs two more capabilities that nodejs-mobile's **Node 18 is built without**:
  - **Unicode `\p{...}` regexes.** ZCode's server source contains a regex *literal* using `\p{L}\p{N}\p{M}\p{S}`. V8 can only compile those with ICU, and this Node has none, so the file failed at **parse time** — before a single line ran. No runtime stand-in can help a file that will not parse, so the shim now rewrites the source the moment before V8 compiles it, swapping each property escape for an equivalent character range.
  - **`Intl`.** The ICU-less build has no `Intl` at all, yet the server formats locale/timezone headers and day ranges with it. The shim installs a small `DateTimeFormat` that formats in the device's own local time.
  - Both substitutions run **only** on a Node without ICU (a normal Linux/Windows Node compiles `\p{...}` and has `Intl`, so it is left completely untouched), and each says so once on stderr.
  - **Proven on the physical phone** (OnePlus 6T, in.mitticloud.app): with the shim, ZCode's real 12 MB `zcode-server.cjs` (build 3.15.3) starts, prints `zcode-hello`, completes the handshake (`client connected` → `stdio mode ready`) and stays alive. Without it, the same run exited 1 in three seconds.
  - **Honest limits:** the Unicode ranges are explicit approximations of the Unicode classes, not the tables themselves; the `Intl` stand-in formats in the phone's local time and cannot resolve an arbitrary IANA zone; and the `node:sqlite` stand-in is in-memory, so ZCode's SQLite-backed task queue and automation history do not survive a restart. The session, file editing and the agent work normally.

## What you get in v0.18.1

- **ZCode's Remote connection actually gets through.** The real reason it failed with "Stream closed before handshake completed" was a Node version gap: ZCode 3.14.x ships its own **Node 22** runtime and its server calls `require("node:sqlite")` at load time. Android cannot run ZCode's glibc binary, so MittiCloud swaps in the Node it ships inside the APK — **Node 18** — where `node:sqlite` does not exist, so the server died instantly with exit 1. MittiCloud now loads a small `node:sqlite` stand-in (via `node --require`) only for `zcode-server.cjs`, so the server boots, completes its handshake and runs the session. Verified locally against ZCode's real 11.5 MB `zcode-server.cjs` build 3.14.5: the handshake completes (`client connected` → `stdio mode ready`).
  - **Honest limit:** the stand-in is an in-memory store, not real SQLite. ZCode's SQLite-backed extras — the off-peak task queue and task/notes persistence — will not survive a restart, and the shim says so once on stderr. The session, file editing and the agent work normally.
- **Cursor and code-server are untouched** by that change: only `zcode-server.cjs` gets the flag.

## What you get in v0.18.0

- **Pick photos, delete exactly those.** The Photos grid has a Select mode: checkboxes on every tile, Select all / Select none, and one Delete selected that removes exactly the picked photos in a single request. Already-gone files are reported, not errored. Deleting also cleans the photo's favorite and duplicate-index entries, which used to linger forever.
- **Host any language, not just Node.** Every app card has a Run panel with two plain boxes: a start command and an optional install command. `python app.py`, `php -S 0.0.0.0:$PORT -t public`, a compiled Go binary — whatever the device can execute runs as a hosted app, with PORT handed to it and the same logs, restart, RAM guard and crash ladder as Node apps. Leave both empty and the automatic Node detection works exactly as before. On Windows write `%PORT%` inside the command.
- **SSH survives a broken terminal helper.** On some devices the bundled PTY proxy (`libmittish.so`) cannot start — the session died with "Stream closed before handshake completed" and a linker warning. Now a helper that dies at startup having produced nothing is treated as absent: the same session restarts on plain pipes and still gives a working shell, and the helper's error is kept in `data/ssh/pty-errors.log` for diagnosis. Turning SSH off also ends every shell it started, instead of leaving them running.
- **Hosted apps stop for real on Windows.** A shell-wrapped start (npm start, a custom command) leaves a cmd.exe wrapper whose real server grandchild survived a plain kill, holding the port forever. Stopping an app now takes the whole process tree down.

## What you get in v0.17.26

- **Public link with nothing to install.** The "Quick public URL" button under Host → Tools used to need a `cloudflared` program installed on the machine — a beginner on a phone cannot install that. The APK now ships the connector (as `libmittitunnel.so`, the same native-library-folder trick as the Node launcher), so in the app you tap the button and a public URL appears in a few seconds. It is Cloudflare's own code rebuilt for Android (the Termux build), because Cloudflare's plain Linux download resolves DNS only through `/etc/resolv.conf`, which Android does not have. Everywhere else it falls back to `cloudflared` on PATH as before.
- **Uploads actually upload.** Photos (one or many), Files (many) and whole-folder hosting could silently do nothing on the phone: Android recreates the app while the file picker is open, which killed the page mid-upload, and a WebView cannot pick a folder with its structure at all. The app now picks and streams itself (native photo, file and folder pickers that stream straight into the server), the desktop dashboard uploads with streaming multipart, and every failure says why in plain words instead of staying silent.
- **Any website, any language, full stack.** Hosting is not "HTML only": static sites serve every file type, and a folder with a package.json runs as a live Node app (Next.js, Express, anything) with install, build and start handled on the phone. The old 2 MB-per-file cap on folder uploads is gone — files stream up to 200 MB each.
- **New app icon.** The launcher icon and the PWA icons use the new MittiCloud mark.
- **A full interactive SSH shell.** The shell channel used plain pipes, so there was no terminal: `isatty()` was false and interactive tools refused to run. The APK now bundles `libmittish.so`, a small PTY proxy (packaged like the Node launcher so Android will execute it), and an interactive session gets a real terminal with working line editing, colours, and window-size changes.
- **ZCode and Cursor can now connect to the phone.** Their Remote-SSH uploads its own `node` and a JavaScript server, then runs them together. Android cannot execute that uploaded Linux binary, so the session died with "Permission denied". MittiCloud now recognises that exact launch and runs the server with the phone's own Node instead — and finds the real shell and PATH Android needs. Not yet verified end to end on a phone.
- **The app is the main path, not Termux.** The phone setup guide leads with the APK — install, tap Start, done — and keeps Termux as the advanced option.
- **The checklist knows where it is running.** MittiCloud reports whether it is the Android app or a Termux install, so the "Living checklist" no longer shows Termux and install steps as forever-pending on the APK — they pass by themselves, and the hints talk about the app instead of hand-installing Termux.
- **No more lock token.** The web app and its APIs are open on your network, so Upload, Add project, Photos and Files just work — no "enter your access token" banner. The one secret is the SSH password (Status → SSH password, or `MITTI_TOKEN` on a VPS), which is the only thing the SSH door uses.
- **Live Node apps finally run on the phone.** Hosted apps used to crash the moment they started: the runner spawned the embedded runtime (`libnode.so`), and Android refuses to execute a file in app storage (the child died with SIGABRT). The APK now ships a small launcher (`libmittinode.so`) in its native library folder — the one place Android lets an app execute from — and the runner uses it. Verified on the OnePlus 6T: a hosted Node server started and answered HTTP.
- **SSH door for plain SSH clients, and for coding agents.** The Remote tab shows the Host, Port, Username and Password (your SSH password). One tap turns the door on; plain SSH and SFTP clients work from any device on the same Wi-Fi, and ZCode or Cursor can deploy their server through it — MittiCloud runs it with the phone's Node because their shipped Linux build cannot run on Android.
- **The SSH shell resolves the right shell.** Android has no `/bin/sh` (it is `/system/bin/sh`) and its core utils live under `/system/bin`; the shell layer finds a real shell and sets a working PATH, so a login's `mkdir`/`cat`/`tar` commands run instead of dying with ENOENT.
- **The APK starts reliably.** Older Android versions (7 to 9) no longer crash the 24/7 service, and the dashboard waits for the server and says what it is doing instead of showing a blank page.
- **One Add-a-project flow.** Choose a folder or a ZIP. MittiCloud decides whether it is a website or a live app. The status words show what it is doing: Waiting, Installing, Building, Starting, Live, or Failed at install / build / start.
- **Next.js, built for you.** A project with a `package.json` and a `build` script is installed and built on the device. Builds run one at a time, so a second project waits its turn. A confirm asks before a heavy build: *This takes a few minutes and warms the phone. Start?*
- **Pages that just work.** A folder with one `.html` file is served as the site. A folder with several pages and no `index.html` shows a plain list of them.
- **Two plain guides.** Connect ZCode or Cursor over SSH (on a VPS). Put a Next.js app online without commands.
- **Photo vault, files, editor, live dashboard, backups, MCP for AI apps** — unchanged from earlier releases.

## Honest limits

- **The APK embeds Node 18** (the prebuilt `nodejs-mobile` runtime). MittiCloud declares Node 20 in `package.json`; its server code was checked for Node 20-only APIs and none were found, but the APK is tested on Node 18 only.
- **The SSH shell is a real interactive shell.** The APK bundles a small PTY proxy (`libmittish.so`, built like the Node launcher); an interactive session gets a genuine terminal, so `isatty()` is true, line editing and colours work, and the client's window size is honoured. It is off by default, lives behind your SSH password, starts inside the vault, and runs as the app's own user — not root. A shell can run any program that user can, so keep the SSH password secret.
- **The APK is phone-verified.** The release build is installed and run on a real OnePlus 6T (Android 11): the server boots, the dashboard loads, the battery reads live, and a hosted Node app runs. Report anything that still misbehaves on your device.
- **Hosted apps run through a bundled launcher.** Android (API 29+) refuses to execute a file an app can write, so the runner cannot start a script from app storage. The APK ships `libmittinode.so` — a real executable, packaged as a native library so Android extracts it into the executable folder — which loads `libnode.so` and calls `node::Start`. Node runs as the app's own user, with no extra privileges.
- **Cloudflare Pages hosts static files only.** A running server needs the tunnel for a public link.
- **Next.js builds run on the device.** They can be slow, and they can fail on a phone with little RAM. A failed build says which step failed.
- **ZCode and Cursor run through the app's SSH door.** They upload their own Linux `node` and server, which Android cannot execute; MittiCloud detects that launch and runs their server with the phone's own Node instead. Because that Node 18 is built without ICU, MittiCloud also supplies a `node:sqlite` stand-in, a `\p{...}` regex rewrite and a local-time `Intl` — verified on a real phone with ZCode 3.15.3 (see v0.18.2). Those stand-ins are approximations (see that section); plain SSH and SFTP clients work as-is, and on a VPS nothing changes.
- **SSH is off by default**, uses port 8022 on a phone (Android blocks port 22 without root), and listens on the Wi-Fi only while it is turned on.

## Architecture

```
[ Any device on Wi-Fi / Tailscale / tunnel ]
        │  HTTP :7333            │  SSH :8022 (plain SSH, SFTP)
        ▼                        ▼
┌─────────────────────────────────────────────────────┐
│  Android APK  ·  Termux  ·  or a VPS (systemd)      │
│                                                     │
│  Node server (Express)                              │
│   ├─ /api/status  /api/photos  /api/files           │
│   ├─ /api/sites   MittiHost    (+ /s/<name>)        │
│   ├─ /api/apps    Live Node apps (ports 7401–7499)  │
│   ├─ /api/remote  SSH door for plain SSH clients    │
│   ├─ /mcp         AI apps with client keys          │
│   └─ vault/  photos · files · sites · apps          │
│                                                     │
│  Dashboard: a React app pre-built into public/      │
└─────────────────────────────────────────────────────┘
```

No database, no CDN. The dashboard is pre-built into `public/`, so the server needs no build step. The server is plain Node with a filesystem.

## Developing

```bash
npm install
npm test          # 187 checks, including a real SSH client against the embedded server
cd web && npm run build   # rebuilds public/ (commit the output)
```

The Android app is built by [`.github/workflows/apk.yml`](.github/workflows/apk.yml) on every version tag. It fetches the prebuilt `nodejs-mobile` runtime, stages the server into the APK, and signs it with a keystore kept in repository secrets.

## Roadmap

- [x] ZCode and Cursor over SSH — their server is JavaScript, so it runs on the phone's Node (verified on a VPS; phone run not yet verified end to end)
- [x] Android APK, built and signed in CI
- [x] One-line VPS installer (systemd)
- [x] Public URLs for MittiHost sites via Cloudflare Tunnel
- [x] SSH password login (set it in Status → SSH password, or `MITTI_TOKEN`)
- [x] Phone-verified APK run (install, boot, live battery and a hosted Node app on a OnePlus 6T)
- [x] Web app with no write-lock — the APIs are open on your network
- [x] Full interactive shell over SSH (a real PTY via the bundled `libmittish.so`, so isatty() is true and the terminal resizes)
- [ ] WebDAV — mount the vault as a drive from any file manager
- [ ] Load balancing across devices

## FAQ

**Does my phone need root?** No. The APK runs as a normal app. Termux runs as a normal app too.

**Is my data private?** It never leaves the device unless you turn on a tunnel or SSH on the LAN. Photos touch nothing but your own Wi-Fi.

**What if Android kills the server?** The foreground service and its notification keep it alive, and the battery exemption stops Android from sleeping it. If it still stops, it restarts on the next tap.

## Credits

Built by **Aarav ([@agra-aarav15](https://github.com/agra-aarav15))** with a fleet of free AI coding agents — because great software should be free, forever, for everyone.

## License

[AGPL-3.0](LICENSE) — free software, copyleft forever. If you make MittiCloud better, you have to share it better.
