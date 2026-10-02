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

## What you get in v0.1

| Feature | What it does |
|---|---|
| 📊 **Live dashboard** | Battery level & charging state, storage, uptime, and tunnel status — at a glance, from any device. |
| 🖼️ **Photo vault** | Upload photos from any device on your Wi-Fi; automatically organized by date (`vault/photos/YYYY/MM/DD/`). |
| 📁 **File server** | Browse folders, download anything at full LAN speed, create and delete folders — no accounts, no round-trips. |
| 🔋 **Keep-alive scripts** | Wake-lock, boot autostart (Termux:Boot), a watchdog that revives the server, and a low-battery alert. |
| 💻 **Graceful demo mode** | Runs on desktop (Windows/macOS/Linux) with mocked battery/storage data — develop and demo without a phone. |

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
│   └─ vault/        → photos/YYYY/MM/DD,     │
│                      files/                 │
│                                             │
│  watchdog.sh · boot.sh · battery.sh         │
└─────────────────────────────────────────────┘
```

No database, no CDN, no build step — a filesystem and vanilla JS. If your Wi-Fi is down, your cloud still works from your desk.

## Roadmap

- [ ] Syncthing auto photo-backup from your daily phone
- [ ] Host a static site straight from the vault
- [ ] "Backend mode" for other free projects (API hosting)
- [ ] Simple auth token
- [ ] One-tap Termux bootstrap script hosted on GitHub Pages

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

> **Note:** v0.1 code complete — screenshots coming with the first phone install.

## License

[AGPL-3.0](LICENSE) — free software, copyleft forever. If you make MittiCloud better, you have to share it better.
