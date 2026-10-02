# MittiCloud — Phone Setup (step by step)

A plain-words guide to turning an old Android phone into your personal cloud.
No root, no paid services, no command-line experience needed.

## What this does

MittiCloud runs a small web server inside the Termux app on your old phone.
Your photos and files stay on the phone itself, and any device on your Wi-Fi
can reach them through a normal browser — free forever, because the "server"
is a phone you already own.

## What you need

- Any old Android phone, **Android 7 or newer** (the one in your drawer is perfect)
- Its charger (you'll keep it plugged in — see Step 4)
- Wi-Fi, the same network as the devices you'll open the dashboard from
- About 15 minutes

---

## Step 1 — Install three apps from F-Droid (not the Play Store)

1. On the phone, open the browser and install **F-Droid**: <https://f-droid.org>
2. From F-Droid, install these three apps:
   - **Termux** — the terminal app where MittiCloud runs
   - **Termux:Boot** — starts MittiCloud automatically when the phone turns on
   - **Termux:API** — lets scripts read the battery level (dashboard + low-battery alert)
3. **Open the Termux:Boot app once**, right after installing. Tap its icon, let
   it open, done. This one tap is what lets it auto-start things later — there
   is nothing to configure inside it.
4. Open the **Termux** app. If Android asks about notifications or storage
   permission, tap **Allow**.

> **Why not the Play Store?** The Play Store builds of Termux are outdated and
> effectively broken — that version was abandoned years ago. F-Droid is the
> only maintained source. Same free apps, working builds.

## Step 2 — Download and install MittiCloud

In the Termux app, type these lines one at a time, pressing Enter after each:

```bash
git clone https://github.com/agra-aarav15/mitticloud.git mitticloud
cd mitticloud
bash scripts/install.sh
```

> Replace `https://github.com/agra-aarav15/mitticloud.git` with the project's GitHub URL (use the green **Code**
> button on the repo page and copy the clone link). If you're reading this on
> GitHub, copy the clone button instead.

The installer updates packages, installs Node.js, creates your `vault/`
folders, and sets up auto-start. If it prints the line about **Termux:Boot**,
that means Termux:Boot isn't installed yet — install it from F-Droid, open it
once, then run `bash scripts/install.sh` again.

Optional (only if you plan to copy photos straight from the phone's gallery
later):

```bash
termux-setup-storage
```

Tap **Allow** when Android asks. The dashboard works fine without it.

## Step 3 — Open your dashboard

On the same phone, open the browser and go to:

<http://localhost:7333>

You should see the MittiCloud dashboard — battery, storage, photos, files.
That's it: your cloud is live.

To start it by hand later (for example after opening Termux fresh):

```bash
cd mitticloud
node server/index.js
```

## Step 4 — The battery settings that actually matter

Android likes to kill background apps. Do these once and your cloud stays up:

1. **Settings → Apps → Termux → Battery → Unrestricted.** On some phones this
   is App info → Battery → **Allow background activity**, or a "battery
   optimization" list — make sure Termux is set to **not optimized**.
2. **Keep the phone plugged in.** A cloud that dies at 15% isn't a cloud.
3. The **screen can stay off** — that's fine and saves power.
4. **Heat is the real enemy, not charging:**
   - A slow charger is better than a fast one (less heat).
   - Keep the phone out of direct sunlight and off soft surfaces (beds, sofas,
     under pillows).
   - Old batteries are happiest sitting around **40–80% charge** — no need to
     stress about a perfect 100%.

MittiCloud's watchdog warns you on the phone when the battery drops below 20%
(needs Termux:API installed).

## Step 5 — Open your cloud from other devices

When the server starts (or after install), the banner shows a line like:

```
    Same Wi-Fi    : http://192.168.1.42:7333
```

On a laptop or tablet connected to the **same Wi-Fi**, open that address and
bookmark it. That's your cloud.

To reach it from *outside* the house — mobile data, work, travel — see
[TUNNEL.md](TUNNEL.md). Option B there (Tailscale) is free and takes five
minutes.

---

## Troubleshooting

**Server unreachable after reboot**
- Open the Termux app once — this alone often brings the server back.
- Check the log: `tail -n 50 data/server.log` (run from the `mitticloud` folder).
- Verify Termux:Boot actually ran: open the **Termux:Boot** app and look at
  its log. If it shows nothing: open Termux:Boot once, re-run
  `bash scripts/install.sh`, then reboot and try again.

**Android killed Termux (it just stops)**
- Do Step 4 properly — battery **Unrestricted** for Termux fixes most kills.
- Run `termux-wake-lock` inside Termux (the installer runs it for you, but it
  doesn't survive reinstalling the Termux app).

**Can't upload / can't see photos from the phone's gallery**
- Run `termux-setup-storage` in Termux and tap **Allow**, then try again.

**"Port already in use" in the log**
- An old MittiCloud is probably still running. Stop it and start again:

  ```bash
  pkill -f "node server/index.js"
  node server/index.js
  ```

  (If `pkill` is not found, install it once with `pkg install procps`.)

- Or run on a different port:

  ```bash
  PORT=7444 node server/index.js
  ```
