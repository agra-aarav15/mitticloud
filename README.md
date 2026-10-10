<div align="center">

# 🏺 MittiCloud

**Your drawer-phone is a cloud now.**

A free personal cloud — photo vault, file server, websites, live Node apps, and a
real SSH door for ZCode — that runs on an old Android phone or a small VPS.
No subscriptions. No paid server. Your files stay where you put them.

*mitti* = soil in Hindi. Your cloud grows at home.

![License](https://img.shields.io/badge/License-AGPL--3.0-blue)
![Node](https://img.shields.io/badge/Node-%3E%3D_20-339933)
![APK](https://img.shields.io/badge/Android-APK-3DDC84)
![Release](https://img.shields.io/badge/release-v0.16-orange)
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

Set a lock token before you expose the port: add `Environment=MITTI_TOKEN=<your token>` to `/etc/systemd/system/mitticloud.service`, then `sudo systemctl daemon-reload && sudo systemctl restart mitticloud`.

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

## What you get in v0.16

- **ZCode over SSH, for real.** ZCode's *Remote connection → SSH* method connects to MittiCloud with the four fields it asks for: host, port, username, password. The Remote tab shows them, one tap turns the SSH door on, and nothing else needs installing. Your files and the agent's context stay on this device.
- **One Add-a-project flow.** Choose a folder or a ZIP. MittiCloud decides whether it is a website or a live app. The status words show what it is doing: Waiting, Installing, Building, Starting, Live, or Failed at install / build / start.
- **Next.js, built for you.** A project with a `package.json` and a `build` script is installed and built on the device. Builds run one at a time, so a second project waits its turn. A confirm asks before a heavy build: *This takes a few minutes and warms the phone. Start?*
- **Pages that just work.** A folder with one `.html` file is served as the site. A folder with several pages and no `index.html` shows a plain list of them.
- **Two plain guides.** Connect ZCode over SSH. Put a Next.js app online without commands.
- **Photo vault, files, editor, live dashboard, lock, backups, MCP for AI apps** — unchanged from earlier releases.

## Honest limits

- **The APK embeds Node 18** (the prebuilt `nodejs-mobile` runtime). MittiCloud declares Node 20 in `package.json`; its server code was checked for Node 20-only APIs and none were found, but the APK is tested on Node 18 only.
- **The APK gives SFTP file access, not a shell.** For a full terminal, use Termux or a VPS.
- **The APK is build-verified, not phone-verified.** The release build compiles, is signed, and contains all three native libraries. It has not been run on a real phone yet. Please report what happens.
- **Cloudflare Pages hosts static files only.** A running server needs the tunnel for a public link.
- **Next.js builds run on the device.** They can be slow, and they can fail on a phone with little RAM. A failed build says which step failed.
- **ZCode's own *Server*, *WSL* and *Docker* methods cannot be joined from MittiCloud.** Only SSH is a real door.
- **SSH is off by default**, uses port 8022 on a phone (Android blocks port 22 without root), and is never exposed to the LAN unless you turn that on.

## Architecture

```
[ Any device on Wi-Fi / Tailscale / tunnel ]
        │  HTTP :7333            │  SSH :8022 (ZCode, SFTP)
        ▼                        ▼
┌─────────────────────────────────────────────────────┐
│  Android APK  ·  Termux  ·  or a VPS (systemd)      │
│                                                     │
│  Node server (Express)                              │
│   ├─ /api/status  /api/photos  /api/files           │
│   ├─ /api/sites   MittiHost    (+ /s/<name>)        │
│   ├─ /api/apps    Live Node apps (ports 7401–7499)  │
│   ├─ /api/remote  SSH door for ZCode                │
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
npm test          # 157 checks, including a real SSH client against the embedded server
cd web && npm run build   # rebuilds public/ (commit the output)
```

The Android app is built by [`.github/workflows/apk.yml`](.github/workflows/apk.yml) on every version tag. It fetches the prebuilt `nodejs-mobile` runtime, stages the server into the APK, and signs it with a keystore kept in repository secrets.

## Roadmap

- [x] ZCode over SSH (embedded SSH server, lock-token auth, jailed SFTP)
- [x] Android APK, built and signed in CI
- [x] One-line VPS installer (systemd)
- [x] Public URLs for MittiHost sites via Cloudflare Tunnel
- [x] Simple auth token (the Lock)
- [ ] Phone-verified APK run (next: install on a real device and report)
- [ ] Full shell over SSH (needs Termux or a VPS; out of scope for the APK)
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
