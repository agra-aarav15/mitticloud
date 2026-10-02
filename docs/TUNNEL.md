# MittiCloud — Getting to your cloud from outside the house

By default, MittiCloud answers only on your home Wi-Fi. That is the safe
default. When you want to reach it from anywhere — mobile data, work, travel —
pick one of the three options below, ranked from simplest to most advanced.

## Option A — LAN only (default, zero setup)

Do nothing. Your cloud lives at `http://<phone-LAN-IP>:7333` (shown in the
startup banner) and works from any device connected to your Wi-Fi.

- **Setup:** none
- **Cost:** free
- **Privacy:** your photos never leave your home network
- **Limit:** only works at home

If that covers you — stop here. For most people, honestly, it does.

## Option B — Tailscale (recommended: free and private)

[Tailscale](https://tailscale.com) creates a private virtual network between
your own devices, over the internet, without opening a single port anywhere.

1. Install the **Tailscale app** on the MittiCloud phone (Play Store or
   F-Droid) and sign in.
2. Install Tailscale on **every device you want access from** (laptop, daily
   phone, tablet) and sign in with the **same account**.
3. That's it. The MittiCloud server itself needs **no Tailscale setup at all**
   — no CLI, no config. The Android app alone puts the phone on your private
   network.
4. From any of your signed-in devices, open either:
   - `http://100.x.y.z:7333` — the `100.x.x.x` address Tailscale assigns to
     the phone (check the Tailscale app or the admin console), or
   - `http://mitticloud:7333` — if you rename the device to `mitticloud` in
     the Tailscale admin console (MagicDNS does the rest).

Why this is the recommended option:

- **Free tier is generous**: up to 3 users and 100 devices — a personal cloud
  won't come close to those limits.
- **No domain needed**, nothing to port-forward, no config files.
- Traffic is **end-to-end encrypted** and visible only to devices on your own
  account.
- Works from anywhere your devices have internet.

## Option C — Cloudflare Tunnel (advanced)

[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
exposes your cloud at a real public hostname through Cloudflare, with no port
forwarding.

**Honest caveat first:** running `cloudflared` inside Termux is *possible*
(the linux-arm64 binary does work) **but finicky** — it isn't packaged for
Termux, so you're managing a raw binary, keeping it running alongside the
server, and doing Cloudflare login from a phone. If your goal is simply remote
access, use Tailscale (Option B) and skip all of this.

Short version, if you still want it:

1. You need your **own domain** on Cloudflare (their free plan is fine).
2. Download the `cloudflared` **linux-arm64** binary, put it somewhere in
   Termux's `$PATH`, and `chmod +x` it.
3. `cloudflared tunnel login`, create a tunnel, and route it to
   `http://localhost:7333`.
4. Expect to debug it — that's exactly why this option is labeled "advanced".

## Security notes — read this once

- **Never port-forward 7333 on your router.** That puts your photo vault on
  the public internet, where scanners find it within hours.
- **The dashboard has no login yet** (a simple auth token is on the v0.2
  roadmap). Until then, treat any URL that isn't LAN-only or Tailscale as
  unsafe.
- Tailscale (Option B) keeps the dashboard private by design: only devices
  signed in to your own account can reach it.
- If you ever use Option C, turn on **Cloudflare Access** (an email-code login
  in front of the tunnel) before sharing the URL with anyone.
