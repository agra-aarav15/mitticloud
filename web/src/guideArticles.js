// Step-by-step guides. Plain words, one action per step. Each step is what you
// tap or type, and what you should see next. No jargon.

export const GUIDE_ARTICLES = [
  {
    id: 'zcode',
    title: 'Connect ZCode or Cursor to a VPS (SSH)',
    intro:
      "ZCode and Cursor need a small Linux server on the machine they connect to. An Android phone cannot run that server, so this guide is for a VPS. The phone's SSH door works for plain SSH clients only.",
    steps: [
      'On the VPS, run the MittiCloud VPS installer. It starts MittiCloud as a background service.',
      'In the Remote tab, tap "Turn SSH on". The card shows the Host address, Port and Username.',
      'On the laptop, open ZCode or Cursor and choose Remote connection, then SSH.',
      'Fill the four fields with what the Remote tab shows: Host, Port, Username, and Password (your MittiCloud lock token).',
      'Tap Connect. Wait until it says Connected, then choose the folder to work in.'
    ],
    ifItFails: [
      'Press "Check" in the Remote tab. It says whether SSH is listening.',
      'The Password is your MittiCloud lock token, not your Wi-Fi password.',
      'On a phone, the port is 8022 (never 22). On a VPS, the system SSH on port 22 works too.',
      'If ZCode says "Permission denied" for a server file, the machine cannot run that server. Use a VPS, not an Android phone.'
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
