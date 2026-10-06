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

## What you get in v0.14

| Feature | What it does |
|---|---|
| 🔌 **MCP — many apps connect** | Any MCP-capable AI app (ZCode, Claude Desktop, Cursor…) gets real tools for your cloud: `server_status, list_files, read_file, write_file, list_photos, list_sites, list_apps, start_app, stop_app, app_logs, memory_context`. Zero-dependency stdio script for apps on your machine, `POST /mcp` over HTTP for apps anywhere — both authed by per-app client keys. |
| 🔑 **Client keys** | One key per app, created in the UI, shown exactly once, stored as a sha256 hash, revocable anytime, never returned by any API, never in backups. |
| 🛰️ **Remote = the connect hub** | Rebuilt around three honest segments: **Apps** (MCP setup with copy-paste config, API keys, the ZCode web remote, an SSH recipe for Termux), **Devices** (pair your laptop, project memory), **Reach** (your real tailnet / tunnel / LAN addresses with copy + share). The sliding segment indicator actually slides. |
| 🤖 **Agent — its own tab** | The REAL lightweight agent (OpenCode, Gemini CLI, or any command) runs on the phone — Claude-Code-class, with its own tools — and MittiCloud is its 24/7 body: chat drives it, output streams live, the watchdog revives it, the battery asks before heavy work, and setup stays two steps: pick a brain, give it a key (or tap install). v0.14 moves it out of Remote into its own tab. |
| 🏅 **MittiBadge** | A live, embeddable badge proving a site runs on a drawer phone: visits today, uptime, power — real numbers, one `<img>` line, zero dependencies. |
| ✨ **Motion that breathes** | One tempo for the whole app: duration/easing tokens, staggered card entrances everywhere, smooth log/preview/env expands, count-up numbers, real button press feedback — and the live-dot pulse actually pulses (v0.13 referenced the animation but nobody had defined it). Everything respects reduced-motion. |
| 🏠 **Home** | Live counts that count up ("2 hosted here"), a hero sentence with running apps included, and five doors: photos, files, host, your agent, connect your apps. |
| 🌐 **MittiHost** | Same one add-flow, now with honest **dead-site diagnosis**: a site that stopped answering says why in human words ("Nothing answers at / — the site's files may be missing an index.html at the root. Update re-uploads them."). |
| 📊 **Live dashboard** | Real battery/storage/uptime, Tailscale/LAN access, and the human-words self-check ("All good — checked just now."). |
| 🖼️ **Photo backup** | Bulk upload from any device, automatic duplicate detection, date albums, favorites, download-all as ZIP. |
| 📁 **Real drive + editor** | Streaming uploads, rename/move/copy/multi-delete, folder ZIP, search — and the monochrome code editor (Host and Files, 200 KB saves, binary files honestly refused, atomic writes). |
| ⚙️ **Live apps** | Node apps with their own port (7401+), `PORT` in the environment, auto npm install with a live log, crash restart with backoff, honest crashed states, log viewer, env editor, RAM guard, run-on-boot, and Export (zip + `mitti.json`) for a VPS takeover. |
| ⚡ **Automations** | Ready-made scheduled jobs with Run-now output and webhook links under Advanced, battery-aware. |
| 🔒 **Lock** | Optional one-token lock: visitors look, only the token changes things — including app deploys, editor saves, and agent turns. Client keys have their own lane for apps. |
| 🗺️ **Living guides** | The checklist that reads real system state and ticks itself off. |
| 🔋 **Battery mode** | Under 30% on battery, heavy work asks first. Agent turns, tasks and scheduled jobs follow the same law. |
| 🛡️ **Robust** | Graceful restarts (hosted apps never orphaned), daily settings backup (7 days kept — agent keys, CF tokens and client keys never backed up), deep `/api/health?deep=1`, and a one-command suite: `npm test` (135 checks, including a real MCP stdio subprocess round-trip). |

## Taking an exported app to a VPS (the roadmap, started honestly)

Export downloads `yourapp-export.zip` containing the app and a `mitti.json` manifest
(entry file, env vars, run-on-boot, RAM cap). Any machine with Node takes over:

```bash
unzip yourapp-export.zip -d yourapp && cd yourapp
npm install --omit=dev        # once, on the new machine
PORT=8080 node index.js       # the same PORT contract MittiCloud uses
```

Multi-device load balancing and one-click migration are the NEXT round — the
registry + manifest + PORT contract above are designed so they slot in. This
release deliberately does not fake them.

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
│   ├─ /api/host     → Go Live (LAN + tunnel) │
│   ├─ /api/tasks    → tasks + secret links   │
│   ├─ /api/sites    → MittiHost  (+ /s/<n>)  │
│   ├─ /api/agent    → Agent Server (24/7,    │
│   │                  multi-provider brains) │
│   ├─ /api/bridge   → Remote: memory         │
│   └─ vault/        → photos/YYYY/MM/DD,     │
│                      files/, sites/,        │
│                      bridge/<session>/      │
│                                             │
│  watchdog.sh · boot.sh · battery.sh         │
└─────────────────────────────────────────────┘
```

No database, no CDN. The dashboard is a small React app built ahead of time into `public/` (committed, so `install.sh` needs no build); the server is plain Node with a filesystem. If your Wi-Fi is down, your cloud still works from your desk.

## Remote — project memory, on the phone

The **Remote** tab keeps three things together: this phone's own 24/7 agent, your laptop's ZCode session through its built-in Web Remote Control, and project memory. The memory part works from your laptop terminal — run Claude Code, ZCode, MiniMax Code (or anything) while the phone stores the session — context window, chat history and project files:

```bash
node scripts/mitti-bridge.mjs new my-project            # → id: a1b2c3d4
node scripts/mitti-bridge.mjs save a1b2c3d4 CLAUDE.md   # store the context
node scripts/mitti-bridge.mjs push a1b2c3d4 ./src       # store the files
node scripts/mitti-bridge.mjs resume a1b2c3d4           # continue from ANY device
```

`resume` prints the full context + chat so you can prime the agent again; `new-chat` keeps the context and clears the chat. Point it at the phone with `MITTI_URL=http://<phone-ip>:7333`.

## Agent Server — a 24/7 agent that lives on the phone

This is the drawer-phone's superpower: the phone holds an agent (in the Claude Code sense) that is *always on*, while you drive it from any browser — laptop, tablet, another phone.

1. Open the **Agent** tab, pick a brain, paste its free API key (stored only on the device, never backed up, never returned by any API).
2. Pick a workspace folder. The agent's file tools are jailed there.
3. Give it a job. It lists/reads/writes real files and runs real commands, showing you every tool call it makes.

Sessions are plain JSON files on the phone — a server restart never eats a conversation (a mid-turn session is honestly marked "the server restarted, send that again"). For true 24/7: Termux:Boot starts MittiCloud at boot, the watchdog revives crashes, and a wake-lock keeps the agent alive — the same keep-alive stack that serves your websites.

## Roadmap

- [ ] Syncthing auto photo-backup from your daily phone
- [ ] Agent skills — more tools, smarter hands
- [x] Public URLs for MittiHost sites via in-app Cloudflare Tunnel (Go Live)
- [x] Simple auth token (the Lock)
- [ ] MittiMesh — many drawer-phones pooling into one cloud
- [ ] WebDAV — mount the vault as a drive from any file manager (next round — it must not ship half-working)
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

> **Note:** v0.12.0 — the honesty round. Every flow that used to lie or dead-end now tells the truth: the CLI installer really installs (Windows `.cmd` spawn bug fixed) and a stuck agent stops with an actionable message instead of hanging forever; a GitHub-style ZIP finally unwraps its wrapper folder so `/s/<name>/` serves; the Custom brain has its Base URL and Model fields; automations got a real console (Run now, last output, webhook link); and the dashboard installs as a real phone app (PWA manifest + monochrome icons). 104 tests green. Live screenshots in [`preview/`](preview/).

## License

[AGPL-3.0](LICENSE) — free software, copyleft forever. If you make MittiCloud better, you have to share it better.
