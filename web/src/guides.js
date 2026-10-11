// Living checklist data — each step maps to REAL system state read from the
// backend (/api/status, /api/tasks). Nothing here is a static install lecture;
// the panel computes pass/pending per step and shows what is actually left.
// Keep points short and actionable. No emojis, no fluff.
//
// Two runtimes exist: the Android APK (device.embedded — everything is already
// inside the app, so the "install" steps pass by themselves) and Termux
// (device.termux — a hand-installed copy). The panel picks the right notes.

export const GUIDE_STEPS = [
  {
    id: 'termux',
    title: 'Cloud app installed',
    desktopNote: 'Desktop demo mode — normal for now. This passes on the phone, either from the APK or inside Termux.',
    passNote: 'MittiCloud is running on the phone.',
    pending: [
      'Install the MittiCloud APK on the phone (grab it from the releases page), or',
      'Install F-Droid, then Termux from F-Droid only — the Play Store Termux is outdated.',
      'Open it once; that becomes the runtime for everything below.'
    ]
  },
  {
    id: 'battery',
    title: 'Battery protected',
    passNote: 'Real battery reporting is active — light mode kicks in under 30% on battery.',
    pending: [
      'Battery reads are mocked because this is not running on the phone yet.',
      'In the APK this turns on by itself. In Termux, install the Termux:API app from F-Droid, then run: pkg install termux-api',
      'MittiCloud then reads the real battery and defers jobs below 30% until charging.'
    ]
  },
  {
    id: 'lan',
    title: 'Reachable on your network',
    passNote: 'The server is answering — you are looking at it.',
    pending: []
  },
  {
    id: 'tailscale',
    title: 'Private mesh (Tailscale)',
    passNote: 'Tailscale is active — reach the cloud privately from anywhere.',
    pending: [
      'Install the free Tailscale app on the phone and on every device you access it from.',
      'Sign in with the same account on all of them.',
      'Then open http://<phone-tailscale-ip>:7333 (100.x.x.x) from anywhere — private mesh, no port forwarding, no domain.'
    ]
  },
  {
    id: 'first-task',
    title: 'First automation turned on',
    passNote: 'At least one automation or task exists.',
    pending: [
      'Automations are little jobs this cloud runs on a schedule — and defers on low battery.',
      'Flip a ready-made switch in the Status tab (Automations card).',
      'Anything you create there also gets its own secret link: POST /hook/<webhookId>.'
    ],
    cta: { label: 'Open Status', tab: 'status' }
  },
  {
    id: 'first-site',
    title: 'First website hosted',
    passNote: 'A site is live from this cloud at /s/<name>.',
    pending: [
      'MittiHost serves websites from this phone — free, no hosting bill.',
      'Host tab: create a site, pick your HTML folder, upload.',
      'It is reachable on your LAN or Tailscale; pair a free Cloudflare Tunnel for a public URL.'
    ],
    cta: { label: 'Open Host', tab: 'host' }
  },
  {
    id: 'bridge',
    title: 'Project memory linked (Remote)',
    passNote: 'A project memory session exists on this cloud.',
    pending: [
      'Project memory stores your coding agent\'s context, chat and files on this phone.',
      'On the laptop: node scripts/mitti-bridge.mjs new <name>, then save <id> CLAUDE.md.',
      'Resume the session from any device with resume <id> — or from the Remote tab.'
    ],
    cta: { label: 'Open Remote', tab: 'remote' }
  },
  {
    id: 'phone-app',
    title: 'Reachable from your other devices',
    passNote: 'The cloud is answering on your network — open a URL above from any device.',
    pending: [
      'Open the cloud from the phone itself at http://localhost:7333.',
      'From a laptop or another phone on the same Wi-Fi, use one of the network URLs shown above.',
      'For access from anywhere, turn on Tailscale or a Cloudflare Tunnel.'
    ]
  }
]