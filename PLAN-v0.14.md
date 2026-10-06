MITTICLOUD v0.14 — THE CONNECT + MOTION ROUND
Saved plan. Decisions locked with Aarav's message + plan-mode approval (Oct 6).
CORRECTION baked in: MittiMotion and MittiGrid are SEPARATE projects —
"Aareav: MITIMOTION, MITIGRID and MITICLOUD are separate projects. Why are you
combining them?" → nothing from them goes into MittiCloud. No hosting, no
shelf, no linking. Their repos stay byte-identical.

===========================
WHAT AARAV SAID (THE BRIEF)
===========================
1. "Host and remote section needs so much work... it is not that I wanted."
2. "The remote section maybe doesn't need to have the agent function."
3. "Remote... should not only be connected through ZCode but also through many
   apps like many...."  → universal connect hub.
4. "The UI is still so unfinished and snappy, but I need some animations delay
   like that... which leaves people to think."  → deliberate motion pass.
(He forgot MittiMotion/MittiGrid existed — mentioned them, then clarified they
stay SEPARATE. Do not integrate them. See correction above.)

===========================
THE BUILD (all in F:\Projects\MittiCloud)
===========================
1. MOTION FOUNDATION (tokens.css + useMotion.js) — DONE
   - Tokens: --t-fast 140ms / --t-med 240ms / --t-slow 420ms / --ease.
   - @keyframes mitti-ping now DEFINED (v0.13 referenced it, defined nowhere —
     LIVE banner + restart pulse were silently dead).
   - .stag (staggered children rise) + .xwrap/.open (280ms smooth expand)
     utilities. Press feedback: .btn scale .98, .iconbtn scale .94, .tab .96.
   - useCountUp hook (600ms, respects prefers-reduced-motion).
   - Mobile tab bar: 8 tabs fit without scroll (flex 1 1 0, 10px labels).

2. CLIENT KEYS (server/lib/clientKeys.js + routes/clients.js) — DONE, 17 tests
   - data/client-keys.json; key = mitti_<base64url>; sha256 at rest.
   - POST /api/clients/keys returns the FULL key exactly once; list redacted;
     DELETE revokes; verifyKey bumps lastUsed (1/min throttle).
   - Backup exclusion (SKIP_FILES) + lockWrites guard. NEVER returned again.

3. MCP SERVER (the "many apps" headline) — DONE, tested
   - server/lib/mcpCore.js: 11 tools — server_status, list_files, read_file,
     write_file, list_photos, list_sites, list_apps, start_app, stop_app,
     app_logs, memory_context. File tools jailed via resolveSafe(FILES_DIR),
     100KB read / 200KB write caps, atomic writes, honest isError results.
   - POST /mcp (routes/mcp.js): HTTP transport, Bearer client-key auth, 401
     with human hint.
   - scripts/mitti-mcp.mjs: zero-dep stdio proxy (stdio JSON-RPC → POST /mcp),
     for ZCode/Claude/Cursor on this machine. Env: MITTI_URL, MITTI_KEY.
     Gotchas fixed: stdin 'end' must DRAIN the in-flight chain (not exit()),
     fetch AbortSignal.timeout(8s), serialized reply order.
   - server/test/connect.test.js: 17 tests incl. REAL stdio subprocess e2e.

4. AGENT GETS ITS OWN TAB (App.jsx) — DONE
   - 8 tabs: Home/Status/Photos/Files/Host/AGENT(bot)/REMOTE(link)/Guides.
   - AgentPanel keeps everything; gets optional onGoTo prop.

5. REMOTE REBUILD (background agent) — IN FLIGHT
   - 3 segments: Apps (MCP card + API keys card + ZCode bookmark + SSH recipe)
     / Devices (bridge pairing + memory, unchanged logic) / Reach (Tailscale +
     tunnel + LAN rows with copy/share; "away from home? tunnel" honesty).
   - Sliding thumb segment indicator (--seg-i translateX, --t-med glide).
   - AgentPanel's 24/7 reach box removed (→ Remote Reach), one line + Open.

6. HOST POLISH (background agent) — IN FLIGHT
   - Dead CSS: GoLive.css orphan (its .golive-retry → HostPanel.css, then
     delete file), .hs-url-path dead rule, .hs-cf-err undefined, dead ternary
     HostPanel.jsx:363, golive-* → tools-* renames.
   - Dead-site diagnosis: human hint on dead cards (404 → "missing index.html
     at the root — Update re-uploads"; else status/error wording).
   - Motion: .stag on card lists, .xwrap for Logs/Env/preview, LIVE banner
     rise, CodeEditor backdrop fade. Card anatomy alignment.

7. HOME (mine) — DONE
   - Live counts (sites+apps via fetchApps, count-up), hero gains running-apps.
   - 5 tiles: Photos / Files / Host (real hosted count) / Meet your agent
     (bot → agent tab) / Connect your apps (link → remote).
   - NO Motion/Grid anything (correction above).

8. SHIP: v0.14.0 everywhere, README "What you get in v0.14", full suite +
   vite build + screenshots gate, commit, push, demo servers stay alive.

===========================
HONEST LIMITS (stated in-app + README)
===========================
- WebDAV (file-manager mounts): NOT this round — needs a compat pass to not
  be a fake button. Next round candidate.
- MCP write_file: jailed to vault/files, 200KB cap, no shell, no uploads.
- SSH card is a recipe for Termux's own sshd — MittiCloud implements no SSH.
- Load balancing / VPS shift: still next round (v0.13 Export-app remains the
  designed first step). MittiGrid-the-project is NOT the mechanism (separate
  projects rule).

===========================
WINDOWS / ENV LAWS THAT STILL APPLY
===========================
- C: fills to 100% → TMPDIR/TMP/TEMP=/f/tmp for builds.
- Subagent concurrency limit 2; background agents used for Remote + Host.
- Git Bash kill is fake on Windows node → taskkill //F //PID $(netstat...).
- Demo servers stay alive after URL report (7333 + hosted apps).
- Keys never returned by any API; client-keys.json backup-skipped.
