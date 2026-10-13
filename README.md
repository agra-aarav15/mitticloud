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
![Release](https://img.shields.io/badge/release-v0.18.0-orange)
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
- **ZCode and Cursor run through the app's SSH door.** They upload their own Linux `node` and server, which Android cannot execute; MittiCloud detects that launch and runs their server with the phone's own Node instead. It has not been verified end to end on a phone yet — report what happens. Plain SSH and SFTP clients work as-is, and on a VPS nothing changes.
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
npm test          # 183 checks, including a real SSH client against the embedded server
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
