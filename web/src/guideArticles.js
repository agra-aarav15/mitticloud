// Step-by-step guides. Plain words, one action per step. Each step is what you
// tap or type, and what you should see next. No jargon.

export const GUIDE_ARTICLES = [
  {
    id: 'zcode',
    title: 'Connect ZCode or Cursor (SSH)',
    intro:
      "ZCode and Cursor connect to this cloud over SSH. They upload their own server and normally run it with a Linux build they ship — but that build cannot run on Android, so on the phone MittiCloud runs it with the phone's own Node instead. You do nothing special; just turn SSH on and connect. (On a VPS everything works the same way, unchanged.)",
    steps: [
      'In the Remote tab, tap "Turn SSH on". The card shows the Host address, Port and Username.',
      'On the laptop, open ZCode or Cursor and choose Remote connection, then SSH.',
      'Fill the four fields with what the Remote tab shows: Host, Port, Username, and Password (your MittiCloud SSH password).',
      'Tap Connect. It uploads its server; MittiCloud starts it with the phone\'s Node.',
      'Wait until it says Connected, then choose the folder to work in.'
    ],
    ifItFails: [
      'Press "Check" in the Remote tab. It says whether SSH is listening.',
      'The Password is your MittiCloud SSH password, not your Wi-Fi password.',
      'On a phone, the port is 8022 (never 22). On a VPS, the system SSH on port 22 works too.',
      'Both devices must be on the same Wi-Fi (or both on Tailscale). A laptop on a different network cannot reach the phone.'
    ]
  },
  {
    id: 'nextjs',
    title: 'Put a Next.js app online (no commands)',
    intro:
      'You do not type any commands. MittiCloud installs and builds the project for you. Builds run one at a time, so a second project waits its turn.',
    steps: [
      'Put the whole project in one folder, or zip it into one ZIP file.',
      'Open the Host tab and tap "Add a project". Choose the folder or the ZIP.',
      'Before it starts, MittiCloud asks "This takes a few minutes and warms the phone. Start?". Tap Start to continue.',
      'The row moves through the steps by itself: Waiting, Installing, Building, Starting, Live.',
      'When it says Live, tap Open to see the site.'
    ],
    ifItFails: [
      'The row says which step failed: install, build or start. Each has a plain reason.',
      'Tap the details arrow on the row to read the log.',
      'A build that runs out of memory stops with a plain message. Try again with the phone charging and fewer apps open.',
      'For a public internet link, use the tunnel. Cloudflare Pages can only host static sites, not running servers.'
    ]
  }
]
