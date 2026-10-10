// Step-by-step guides. Plain words, one action per step. Each step is what you
// tap or type, and what you should see next. No jargon.

export const GUIDE_ARTICLES = [
  {
    id: 'zcode',
    title: 'Connect ZCode from your phone',
    intro:
      "This is ZCode's own feature, called Mobile remote control. MittiCloud is not involved and does not connect to ZCode.",
    steps: [
      'On the laptop, open ZCode with a project open.',
      'Look at the bottom of the left sidebar, next to your avatar. Tap the phone icon, labelled "Mobile remote control".',
      'The window starts by itself. Wait until it says "Waiting for phone".',
      'Scan the QR code with your phone camera. Or tap "Copy link" and open that link in the phone browser.',
      'Success: your workspace and chats appear on the phone.',
      'Keep the laptop on and online. Only one phone page works at a time. "Refresh QR" makes a new link. "Stop" ends the session.'
    ],
    ifItFails: [
      'Check that the laptop is on and online.',
      'Press "Refresh QR" and scan the new code.',
      'Update ZCode to the latest version.',
      'If ZCode asks you to sign in, sign in with your ZCode account.'
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
