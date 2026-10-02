# MittiCloud v0.1 — Build Spec (single source of truth)

**Mission:** Turn an old Android phone (running Termux) into a free personal cloud:
photo vault, file server, and status dashboard. Free forever, AGPL-3.0, no paid
services required. Tagline: **"Your drawer-phone is a cloud now."**

**Runtime:** Node >= 20, Express, no database (filesystem only). Primary target:
Termux on Android. Must also run and be testable on desktop (Windows/macOS/Linux) —
every Termux-dependent feature degrades gracefully with `mocked: true`.

**Port:** `7333` (override with `PORT` env var).

## Directory contract

```
F:\MittiCloud\
  server/
    index.js            Express app: JSON body parsing, static /photos mount, routes, listen 7333
    lib/termux.js       Termux detection + battery/storage with graceful fallbacks
    lib/store.js        Tiny JSON store (data/state.json)
    routes/status.js    GET /api/status
    routes/photos.js    GET /api/photos, POST /api/photos/upload, DELETE /api/photos
    routes/files.js     GET /api/files, GET /api/files/download, POST /api/files/mkdir, DELETE /api/files
    routes/health.js    GET /api/health
  public/               (owned by frontend agent)
    index.html, app.js, style.css
  scripts/              (owned by shell agent)
    install.sh, boot.sh, watchdog.sh, battery.sh
  docs/                 (owned by shell agent)
    PHONE-SETUP.md, TUNNEL.md
  README.md, LICENSE    (owned by docs agent)
  package.json, .gitignore (owned by backend agent)
  data/                 runtime state (gitignored, auto-created)
  vault/                user data (gitignored, auto-created)
    photos/YYYY/MM/DD/
    files/
```

## API contract

- `GET /api/health` → `200 { ok: true, uptimeSec: number }`
- `GET /api/status` →
  ```json
  {
    "battery": { "level": 87, "charging": true, "temperature": 30.4, "mocked": false },
    "storage": { "total": 64000000000, "free": 12000000000, "usedPct": 81.2, "mocked": false },
    "uptimeSec": 3600, "version": "0.1.0",
    "device": { "termux": false, "platform": "win32" },
    "tunnel": { "mode": "lan", "hint": "Open http://<this-phone-LAN-IP>:7333 from any device on the same Wi-Fi." }
  }
  ```
  - `tunnel.mode`: `"tailscale"` if a `tailscale` CLI is found or a 100.x.x.x address sits on a tailscale-like interface; `"cloudflared"` if `cloudflared` is on PATH; else `"lan"`.
  - Battery: on Termux run `termux-battery-status` and parse; else `{ level: 87, charging: true, temperature: null, mocked: true }`.
  - Storage: try `fs.statfs` on the vault dir; on failure return `{ total: null, free: null, usedPct: null, mocked: true }`.
- `GET /api/photos` → `{ photos: [ { name, path: "2026/10/02/abc123.jpg", url: "/photos/2026/10/02/abc123.jpg", size: 120000, uploadedAt: "ISO" } ] }` — newest first, max 500.
- `POST /api/photos/upload` — multipart, field name `photos`, multiple files allowed. Saves to `vault/photos/YYYY/MM/DD/<timestamp>-<random6>.<ext>`. → `{ uploaded: [ ...same shape as above ] }`.
- `GET /photos/<year/month/day/file>` — static file from `vault/photos` (Express static mount).
- `DELETE /api/photos?path=<rel path under vault/photos>` → `{ deleted: true }`.
- `GET /api/files?path=<rel>` → `{ path: "", entries: [ { name, type: "file"|"dir", size, modifiedAt } ] }` — root is `vault/files`; `path` defaults to `""`; reject any path escaping the root (no `..`, resolve and verify prefix).
- `GET /api/files/download?path=<rel>` → file stream (Content-Disposition attachment).
- `POST /api/files/mkdir` body `{ path }` → `{ created: true }`.
- `DELETE /api/files?path=<rel>[&force=true]` → deletes file or dir; refuse non-empty dir unless `force=true`.
- All errors → `{ error: string }` with proper status codes (400/404/500).

## Vault layout (gitignored)

`vault/photos/YYYY/MM/DD/*` and `vault/files/**`. `data/` holds `state.json`, `server.log`, `watchdog.log`.

## Non-negotiables

1. Zero paid dependencies. No external CDNs in the frontend (must work offline on LAN).
2. Vanilla JS frontend, no build step, mobile-first dark glassmorphism theme.
3. Every endpoint must answer sensibly on desktop (mocked Termux data) so development and demos work without a phone.
4. Safe path handling everywhere — no traversal outside the vault root.
