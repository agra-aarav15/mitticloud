<div align="center">

# 🏺 MittiCloud — Your drawer-phone is a cloud now.

**Turn any old Android phone into a free personal cloud — photo vault, file server, live dashboard — powered by Termux, zero subscriptions, no paid server ever.**

*mitti* = soil in Hindi. Your cloud grows at home.

![License](https://img.shields.io/badge/License-AGPL--3.0-blue)
![Node](https://img.shields.io/badge/Node-%3E%3D_20-339933)
![Platform](https://img.shields.io/badge/Platform-Termux-3DDC84)
![PRs](https://img.shields.io/badge/PRs-welcome-brightgreen)

</div>

---

## Why

- **The free photo trap is closing.** Google's free 15 GB is ending for millions — and your memories were the bait. MittiCloud keeps every photo on hardware you own, on a network you trust.
- **Free-tier servers come and go.** Oracle's "always free" instances get reclaimed, credits expire, fine print changes. A drawer-phone never asks for a credit card and never sends you a bill.
- **Half a billion phones are sleeping.** ~500 million old phones sit in drawers doing nothing while e-waste piles up. The most powerful computer you already own deserves better than a junk drawer.

## What you get in v0.7

| Feature | What it does |
|---|---|
| 📊 **Live dashboard** | Battery level & charging state, storage, uptime, tunnel status, deep health checks — at a glance, from any device. |
| 🖼️ **Photo backup** | Bulk upload from any device, automatic duplicate detection, date albums, favorites, download-all as ZIP. |
| 📁 **Real drive** | Upload files and folders (streaming — big files OK), rename, move, copy, multi-select delete, download a folder as ZIP, search, per-folder storage usage. |
| 🌐 **MittiHost** | Host real websites from the phone — upload a folder or a ZIP, live at `/s/<name>` on your LAN or Tailscale; one command gives a free public URL. |
| 💻 **Sandbox** | Run JS or Python on the phone from the dashboard — safely, with timeouts and output caps. |
| ⚡ **MittiOps** | Scheduled jobs + webhook triggers (`POST /hook/<id>`) with run history — automation that lives on your phone. |
| 🤖 **MittiAgent** | A background AI helper on a schedule (free Gemini key) that writes notes, runs tiny scripts and fetches pages. |
| 🧠 **Cloud Mode** | Your laptop coding agent's brain on the phone: context window, chat history, project files — resume any session from any device (`scripts/mitti-bridge.mjs`). |
| 🔒 **Lock** | Optional one-token lock: visitors can look, only the token can change anything. |
| 🗺️ **Living guides** | A checklist that reads real system state (Termux? Tailscale? first site? agent linked?) and ticks itself off — useful long after install. |
| 🔋 **Battery mode** | Under 30% on battery, heavy work asks first: *"This could heat the phone — run anyway?"* Deferred jobs run when charging. |
| 🛡️ **Robust** | Graceful restarts, daily settings backup (7 days kept), deep `/api/health?deep=1`, and a one-command test suite: `npm test` (65 checks). |

## Quick Start (Termux)

**1. Install the three F-Droid apps** (don't use Play Store builds — they're outdated):

- [Termux](https://f-droid.org/packages/com.termux/)
- [Termux:Boot](https://f-droid.org/packages/com.termux.boot/) — start MittiCloud when the phone boots
- [Termux:API](https://f-droid.org/packages/com.termux.api/) — real battery & storage readings

**2. Clone and install:**

```bash
git clone https://github.com/agra-aarav15/mitticloud.git mitticloud
cd mitticloud
bash scripts/install.sh
```

> **Note:** `https://github.com/agra-aarav15/mitticloud.git` becomes the real GitHub URL once this repo is pushed. If you're reading this on GitHub, copy the clone button instead.

**3. Start it:**

```bash
npm start
```

**4. Open the dashboard:**

- On the phone: <http://localhost:7333>
- From any device on the same Wi-Fi: `http://<phone-LAN-IP>:7333` (the dashboard shows you the hint)

📖 New to Termux? The friendly, step-by-step walkthrough — including battery-care settings and boot autostart — is in **[docs/PHONE-SETUP.md](docs/PHONE-SETUP.md)**.
🌍 Want access from *outside* the house? See **[docs/TUNNEL.md](docs/TUNNEL.md)** (Tailscale recommended).

## Architecture

```
[ Any device on Wi-Fi / Tailscale ]
              │
              │   HTTP :7333
              ▼
┌─────────────────────────────────────────────┐
│  Old Android phone  +  Termux               │
│                                             │
│  Node / Express server                      │
│   ├─ /api/status   → live dashboard         │
│   ├─ /api/photos   → photo vault            │
│   ├─ /api/files    → file server            │
│   ├─ /api/sandbox  → code runner            │
│   ├─ /api/tasks    → MittiOps + webhooks    │
│   ├─ /api/sites    → MittiHost  (+ /s/<n>)  │
│   ├─ /api/agent    → MittiAgent scheduler   │
│   ├─ /api/bridge   → Cloud Mode sessions    │
│   └─ vault/        → photos/YYYY/MM/DD,     │
│                      files/, sites/,        │
│                      bridge/<session>/      │
│                                             │
│  watchdog.sh · boot.sh · battery.sh         │
└─────────────────────────────────────────────┘
```

No database, no CDN, no build step — a filesystem and vanilla JS. If your Wi-Fi is down, your cloud still works from your desk.

## Cloud Mode — your coding agent's brain, on the phone

Run Claude Code, ZCode, MiniMax Code (or anything) on your laptop while the phone stores the session — context window, chat history and project files:

```bash
node scripts/mitti-bridge.mjs new my-project            # → id: a1b2c3d4
node scripts/mitti-bridge.mjs save a1b2c3d4 CLAUDE.md   # store the context
node scripts/mitti-bridge.mjs push a1b2c3d4 ./src       # store the files
node scripts/mitti-bridge.mjs resume a1b2c3d4           # continue from ANY device
```

`resume` prints the full context + chat so you can prime the agent again; `new-chat` keeps the context and clears the chat. Point it at the phone with `MITTI_URL=http://<phone-ip>:7333`.

## Roadmap

- [ ] Syncthing auto photo-backup from your daily phone
- [ ] MittiAgent skills (more tools, smarter schedules)
- [ ] Public URLs for MittiHost sites via one-command Cloudflare Tunnel
- [ ] MittiMesh — many drawer-phones pooling into one cloud
- [ ] Simple auth token
- [ ] One-tap Termux bootstrap script hosted on GitHub Pages
- [ ] Verified Play Store APK wrapper

## FAQ

**Does my phone need root?**
No. Everything runs inside Termux as a normal app. If you can install F-Droid, you can run MittiCloud.

**Will the battery explode?**
No. Keep it plugged in, in a cool spot, and follow the battery-care notes in [docs/PHONE-SETUP.md](docs/PHONE-SETUP.md). Old phones are happiest sitting at 40–80% — the low-battery alert script watches that for you.

**Is my data private?**
It never leaves your phone unless *you* enable a tunnel. On plain LAN mode, your photos touch nothing but your own Wi-Fi.

**What if Android kills the server?**
That's the fun part of Android — and exactly why the keep-alive stack exists: a watchdog revives crashes, Termux:Boot restarts after reboots, and a wake-lock keeps Termux alive. It's stubborn on purpose.

## Credits

Built by **Aarav ([@agra-aarav15](https://github.com/agra-aarav15))** with a fleet of free AI coding agents — because great software should be free, forever, for everyone.

---

> **Note:** v0.7.0 — the backend grew up: real drive, real photo backup, lock, health checks, daily backups, ZIP everywhere. Live screenshots in [`preview/`](preview/).

## License

[AGPL-3.0](LICENSE) — free software, copyleft forever. If you make MittiCloud better, you have to share it better.
