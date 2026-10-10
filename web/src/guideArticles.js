// Step-by-step guides. Plain words, one action per step. Each step is what you
// tap or type, and what you should see next. No jargon.

export const GUIDE_ARTICLES = [
  {
    id: 'zcode',
    title: 'Connect ZCode to your phone or VPS (SSH)',
    intro:
      "ZCode's Remote connection, SSH method, connects to MittiCloud. Your project files and the agent's context stay on this device; ZCode works on them over SSH.",
    steps: [
      'On this phone (Remote tab, step 3) tap "Turn SSH on". The card shows the port and username.',
      'On the laptop, open ZCode. In the New task box, open "Select project" and choose "Remote connection".',
      'Pick SSH as the method, then tap Next.',
      'Fill the four fields with what the Remote tab shows: Host (this phone or VPS address), Port, Username, and Password (your MittiCloud lock token).',
      'Tap Connect. Wait until it says Connected, then choose the folder to work in.',
      'Keep this device on and on the same Wi-Fi, or turn on the tunnel for outside access.'
    ],
    ifItFails: [
      'Press "Check" in the Remote tab. It says whether SSH is listening.',
      'The Password is your MittiCloud lock token, not your Wi-Fi password.',
      'On a phone, the port is 8022 (never 22). On a VPS, the system SSH on port 22 works too.',
      'The bare Android app gives file access only, not a full shell. For a full terminal use Termux or a VPS.'
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
