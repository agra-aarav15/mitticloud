// Guided setup data — shown in the Guides panel as an accordion checklist.
// Keep points short and actionable. No emojis, no fluff.

export const GUIDES = [
  {
    id: 'apps',
    title: 'Get the apps',
    minutes: 5,
    points: [
      'Install F-Droid on the phone from f-droid.org.',
      'From F-Droid only, install Termux, Termux:Boot and Termux:API — the Play Store versions are outdated and broken.',
      'Open the Termux:Boot app once after install, so Android is allowed to wake it on boot.'
    ]
  },
  {
    id: 'install',
    title: 'Install MittiCloud',
    minutes: 5,
    points: [
      'In Termux: git clone https://github.com/agra-aarav15/mitticloud.git mitticloud && cd mitticloud',
      'Run bash scripts/install.sh — it prepares Node and the server.',
      'When it finishes, start the cloud with npm start.'
    ]
  },
  {
    id: 'open',
    title: 'Open your cloud',
    minutes: 2,
    points: [
      'On the phone itself: http://localhost:7333',
      'From any device on the same Wi-Fi: http://<phone-ip>:7333 — the server banner prints the IP at startup.'
    ]
  },
  {
    id: 'alive',
    title: 'Battery & heat care',
    minutes: 3,
    points: [
      'Settings → Apps → Termux → Battery → Unrestricted, so Android never kills the server.',
      'Keep the phone plugged in — screen off is fine.',
      '40–80% charge is the happy zone. Keep it cool and out of the sun.',
      'On battery below 30%, MittiCloud switches to light mode and asks before heavy work — that protects your phone.'
    ]
  },
  {
    id: 'tailscale',
    title: 'Reach it anywhere — Tailscale',
    minutes: 10,
    points: [
      'Install the free Tailscale app on the phone and on every device you access it from.',
      'Sign in with the same account on all of them.',
      'Then open http://<phone-tailscale-ip>:7333 (100.x.x.x) from anywhere — private mesh, no port forwarding, no domain.'
    ]
  },
  {
    id: 'cloudflared',
    title: 'Advanced — Cloudflare Tunnel',
    minutes: 15,
    points: [
      'Optional. Needs your own domain and the free cloudflared client.',
      'A tunnel exposes the cloud to the whole public internet — not just your devices.',
      'Only do this after adding authentication (see the roadmap).'
    ]
  }
]
