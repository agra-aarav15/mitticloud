# MittiCloud v0.13 — THE REAL HOST ROUND

Saved 2026-10-02. We build this tomorrow (2026-10-03). Decisions below are locked with Aarav's answers.

## WHAT YOU DECIDED (LOCKED)
1. **HOME** — remove the command box. Home = live hero + tiles + continue + setup. The "give your cloud a job" promise moves to the agent, where it actually runs. No more promising without doing.
2. **HOST** — full rework: site cards with a real LIVE moment + **LIVE NODE APP HOSTING** (own port per app, backend fully configured, auto npm install on deploy, editable anytime with a real editor).
3. **REMOTE** — same 3-segment layout, but each segment made to genuinely function ("functioning like a real one").
4. **STATUS** — human-words self-check. Automations stay in Status.
5. **EDITOR** — one monochrome code editor used in BOTH Host (app files) and Files (any text file).
6. **HONEST SCOPE** — one-click multi-device expansion / load balancer / VPS-shift is designed-for but NOT built this round. This round ships a real first step: "Export app" (zip + mitti.json manifest), so any VPS or device can run the app with one command. No fake buttons.

## FLAWS FOUND (EVIDENCE) — WHAT THIS ROUND KILLS

### HOME
- Box only answers, never runs: `buildAnswer()` has 7 question types, nothing else (HomePanel.jsx:39-101). Placeholder promises "it runs for real" — a lie.
- Try-chips re-answer what the hero line already shows one inch above.
- Unparseable job silently creates an agent session and yanks you to Remote (HomePanel.jsx:224-247).
- Chips vanish while typing, layout jumps (HomePanel.jsx:263).

### STATUS
- "vault writable" chip renders twice — from `health.vaultWritable` (StatusPanel.jsx:571) AND as raw check name from `health.checks` (line 575).
- "DATA-JSON" is an internal check name shown to humans.
- "All checks pass" checks JSON parsing — not whether your sites respond, not backup age.
- Run-now result is two clicks away; toast says "open Last output" then output auto-opens — mismatch (AutomationsCard.jsx:123-126).
- Nightly health desc says it logs uptime; code doesn't (AutomationsCard.jsx:30 vs 31-33).

### HOST
- You cannot OPEN your own site from the Host tab. URL shown is a relative path, tap only copies (HostPanel.jsx:462-470).
- Publishing ends as a 3-second toast — no live moment (HostPanel.jsx:257).
- Name required BEFORE picking a folder; natural order reversed (HostPanel.jsx:210).
- Two equal upload buttons (folder vs ZIP) — implementation detail in your face.
- No preview, no per-site publish, no share.
- Custom domain = a paragraph sending you to the Cloudflare dashboard (GoLive.jsx:165-167).
- Load test sits at the same visual weight as hosting itself (GoLive.jsx:398-423).
- Empty state is a jargon wall: LAN, Tailscale, Cloudflare Tunnel before your first site exists (HostPanel.jsx:421-422).

### REMOTE
- Three unrelated products stapled together (RemotePanel.jsx:365-424).
- 5 decisions before your first agent reply (AgentPanel.jsx:304-461).
- "{prompt}" developer jargon in a visible input (AgentPanel.jsx:364).
- Raw LAN IP shown as the "runs 24/7" address — false the moment you leave home; tunnel never mentioned here (AgentPanel.jsx:294-299).
- "Memory" overlaps Files, and the real magic (mitti-bridge) is never surfaced in the UI (RemotePanel.jsx:148-363).

## THE BUILD

### 1. HOME: remove the box, keep the life
- Delete command box, try chips, buildAnswer, sendJob (HomePanel.jsx:276-325, 39-108, 193-255).
- Hero keeps ticking live. Tiles get upgraded with their real numbers (photo count, sites count, agent state) and become the doors.
- Remote tile subtitle becomes "Your agent — give it a job". Continue + Finish-setting-up stay.

### 2. STATUS: human words
- Self-check becomes plain-language rows from REAL checks:
  - "Storage is writable" (vaultWritable)
  - "Memory looks fine — 1.9 GB free" (humanized; warn under 300 MB)
  - "Both sites responding" (NEW: deep health HEADs every /s/name/ and counts failures)
  - "Last backup: 2 days ago" (NEW: reads backups dir; warn when none or over 7 days)
- Internal names (data-json, vault-writable) never rendered. All good = one line: "All good — checked just now."
- "Backup now" stays; result shows as "Last backup: today 12:00".
- Automations: Run now opens the output immediately with the fresh run; Webhook moves inside an "Advanced" disclosure; nightly-health code gains the uptime line it promises.

### 3. HOST: the full rework

**3a. ONE ADD FLOW (static + apps)**
- One card "Add a site or app": primary button picks a folder, secondary picks a ZIP. Name auto-fills from the folder/zip name, editable. Deploy starts on pick.
- Type auto-detected: package.json or a .js entry = app; index.html = static. Shown as a chip while uploading.
- THE LIVE MOMENT: after deploy, a full-width banner: "<name> is live." with Open / Copy / Share (navigator.share on phone, copy fallback). Stays until dismissed.

**3b. SITE CARDS (static)**
- LIVE dot from a real server-side check. Full absolute URL. Open + Copy + Share buttons. Files/size chips. Lazy preview thumbnail (scaled iframe, monochrome frame). "Update" re-picks folder/zip and replaces. Per-site "Publish to Cloudflare" (moves from the wizard; connect form inline when no token). Delete stays two-step.
- Empty state rewritten in human words.

**3c. LIVE APPS — new engine (the headline feature)**
- `server/lib/apprunner.js`: spawn node (entry detect: package.json scripts.start || main || index.js/server.js/app.js), cwd `data/apps/<name>/`, own port scanned free in 7401-7499, env gets PORT + scrubbed copy, waits for HTTP 200 (5s), states STARTING / RUNNING / STOPPED / CRASHED, crash restart with backoff x3 then honest CRASHED, ring-buffer logs (200 lines), run-on-boot honored at server start.
- Deploy: folder/zip into `data/apps/<name>/` → auto `npm install --omit=dev` when package.json exists (live log, 5-min cap, honest offline failure) → start. Every command runs on the deployment, as Aarav said.
- Resource-aware, honestly: per-app RAM/CPU best-effort (/proc on Termux, tasklist on Windows, "—" when unreadable — never a guess). Global guard: refuse new starts when free RAM is under 300 MB, with a clear message. Per-app RAM cap setting.
- Routes: GET/POST /api/apps; POST /api/apps/:name/start|stop|restart; GET /api/apps/:name/logs; PATCH /api/apps/:name (env, entry, runOnBoot, ramCapMB); DELETE (stop + remove); POST /api/apps/:name/export (zip + mitti.json manifest — the VPS handoff).
- App card: state chip + Start/Stop/Restart + own-port URL with Open/Copy/Share + live Logs viewer + Env editor (key/value rows) + file list into the editor + Export.
- Cloudflare publish stays STATIC-only; app cards say honestly: "Apps run on this phone — publish is for static sites. Use a tunnel (Tools) for a public URL."

**3d. GO LIVE SLIMS DOWN**
- Becomes "Tools": LAN links, load test, quick/token tunnel, cloudflared help — all under one Advanced disclosure. The hosting story now lives in the cards.

### 4. EDITOR: one component, two doors
- New routes: GET/PUT /api/file-content (path-jailed to the vault, 200 KB cap, binary sniff refuses, lock token on PUT, atomic write).
- `web/src/panels/CodeEditor.jsx`: monochrome textarea, mono font, Save/Cancel, unsaved-changes guard.
- Doors: Files tab (tap a text file to edit) and Host app card (file list to edit). After saving into a running app: one-tap "Restart to apply".

### 5. REMOTE: same layout, made real
- Agent setup = 2 visible steps: "1 Pick a brain / 2 Give it a key or tap install". If no CLI installed, the API-key path leads. Raw "Command — use {prompt}" moves under Advanced. Provider raw ids get proper labels.
- The 24/7 box: shows the tunnel/Tailscale URL when one exists (from /api/status); raw LAN IP only as fallback, plus one honest line: "Away from home? Turn on the tunnel — Host → Tools."
- ZCode segment: link validation (must start with http); paired view = one line + Open; unpaired keeps the 3 steps.
- Memory segment: new "Pair your laptop" card showing the exact mitti-bridge command with token embedded + copy button (server provides it); "Copy context + chat" stays; "Download context" (.txt) added.

### 6. THE GATE — executed for real before calling it done
- Deploy a real zero-dep Node app by folder → own port → open → 200.
- Deploy an express app → npm install log → runs → env var visible in its output.
- Edit a file in the editor → Restart to apply → changed response served live.
- Break an app on purpose → honest CRASHED state, logs show why → restart recovers.
- Static flow: folder → LIVE moment → Open/Copy/Share; wrapper-folder ZIP still unwraps.
- Status: deliberately break a site → "sites responding" row reacts; Backup now updates the backup-age row.
- Editor: save verifies on disk; PUT refuses path-traversal, >200 KB, and binary.
- ~12 new tests (apprunner lifecycle with real child processes, port scan, env scrub, entry detect, export manifest, file-content auth/cap/binary, deep-health site checks) on top of the existing 104 staying green.
- v0.13.0, README gains the roadmap: "how a VPS takes an exported app — one command", push, all servers stay alive.

## HONEST LIMITS (stated in-app and README, never hidden)
- Multi-device load balancing and one-click VPS migration are NOT in this build. Export app is the real first step; the app registry + manifest + PORT contract are designed so that round slots in cleanly.
- Python apps: not this round (engine takes a second runner later).
- No subpath proxy for apps — own port only (websockets and absolute paths just work).
- Cloudflare Pages publishes static only; that is a Cloudflare fact, stated where it matters.

## BUILD ORDER (tomorrow)
1. server: apprunner.js + /api/apps routes + file-content routes + deep-health site/backup checks (tests as you go)
2. web: CodeEditor.jsx + Files door
3. web: Host rework (add flow, site cards, app cards, Tools)
4. web: Status human-words self-check + Automations polish
5. web: Home box removal + tile numbers
6. web: Remote polish (setup steps, 24/7 box, ZCode validation, memory pair card)
7. GATE for real, screenshots, v0.13.0, push
