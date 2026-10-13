// Every word Porthole shows on screen lives here. Views never write literal user-facing strings.
//
// Voice rules (docs/superpowers/plans/2026-10-13-p3-shared-screens.md, "Voice"):
//  1. Everyday words. Never on screen: WebSocket, PTY, HTTP, status numbers, JSON, clientMsgId,
//     origin, CORS, endpoint, payload, stdout, tmux pane id.
//  2. Errors say what happened, then what to do, and keep Ben's text on screen.
//  3. Buttons are verbs naming the result.
//  4. hostd's own `reason` strings are plain sentences: show them under a plain headline
//     (see `reasonLine`), never as the only message.
//  5. No exclamation marks, no blame, no "Oops". Times are relative and short (format.js).
//  6. Empty states teach the next step.
//
// Functions take plain values and must return a sentence for any string or number you give them.

/**
 * Freezes `o` and everything inside it.
 * @template T
 * @param {T} o
 * @returns {T}
 */
function deepFreeze(o) {
  if (o !== null && typeof o === "object") {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

/**
 * hostd's reason, as a sentence that starts with a capital letter and ends with a full stop.
 * @param {string | number} reason
 * @returns {string}
 */
function reasonLine(reason) {
  const s = String(reason).trim();
  if (s === "") return "";
  const cap = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?…]$/.test(cap) ? cap : cap + ".";
}

/**
 * @param {number | string} n
 * @returns {string}
 */
function needYou(n) {
  return Number(n) === 1 ? "1 needs you" : `${n} need you`;
}

export const copy = deepFreeze({
  // ---- The fixed strings the acceptance checks use (the plan's Voice table) ----
  reconnecting: "Reconnecting…",
  reconnected: "Connected again.",
  sendHeld: "Not sent yet. Your message is saved and will go out when the connection is back.",
  sendFailedTitle: "Couldn't send. Your message is still here.",
  pendingTitle: "Waiting for the agent to pick it up. Your message is saved.",
  liveVoiceKeys: "Live voice is on at the desk: keys go to the live panel (Space mutes, Esc ends it)",
  noRepo: "No git repo here",
  answerInTerminal: "Answer this in the terminal",
  inboxEmpty: "Nothing needs you. New questions from your agents show up here.",
  draftSaveFailed: "This device couldn't save your draft. Copy it somewhere safe before leaving.",

  // ---- Functions for strings with values ----
  needYou,
  cannotReach: (/** @type {string | number} */ machine) => `Can't reach ${machine}. It may be asleep or offline. Porthole keeps trying.`,
  contextLeft: (/** @type {number | string} */ n) => `${n}% of the context left`,
  contextLeftWarn: (/** @type {number | string} */ n) => `${n} % context left`,
  machineDownAgo: (/** @type {string | number} */ ago) => `Can't reach it · ${ago}`,
  configFor: (/** @type {string | number} */ machine) => `Config · ${machine}`,
  configTitle: (/** @type {string | number} */ machine) => `Config for ${machine}`,
  closeSession: (/** @type {string | number} */ name) => `Close ${name}`,
  removeMachine: (/** @type {string | number} */ name) => `Remove ${name}`,
  removeFile: (/** @type {string | number} */ name) => `Remove ${name}`,
  answered: (/** @type {string | number} */ label) => `Answered: ${label}`,
  lastRead: (/** @type {string | number} */ ago) => `Last read ${ago}`,
  usagePercent: (/** @type {number | string} */ n) => `${n}% used`,
  usageUnavailable: (/** @type {string | number} */ retryIn) => `Couldn't read usage right now. Porthole will try again in ${retryIn}.`,
  previewPort: (/** @type {number | string} */ port) => `Port ${port}`,
  proxyPort: (/** @type {number | string} */ port) => `Open it from this device through port ${port}.`,
  voiceKeptCount: (/** @type {number | string} */ n) => (Number(n) === 1 ? "1 recording kept" : `${n} recordings kept`),
  restartNeeded: (/** @type {string | number} */ machine) => `Saved. Restart Porthole on ${machine} for this to take effect.`,
  moreFiles: (/** @type {number | string} */ n) => (Number(n) === 1 ? "1 more file" : `${n} more files`),
  sessionCount: (/** @type {number | string} */ n) => (Number(n) === 1 ? "1 session" : `${n} sessions`),
  reasonLine,

  // ---- App chrome and the drawer ----
  appName: "Porthole",
  menu: "Menu",
  closeMenu: "Close menu",
  back: "Back",
  close: "Close",
  reload: "Reload",
  refreshing: "Refreshing…",
  loading: "Loading…",
  tryNow: "Try now",
  tryAgain: "Try again",
  linkChat: "Chat",
  linkTerminal: "Terminal",
  machines: "Machines",
  inbox: "Inbox",
  openOnDevice: "Open on this device",
  chats: "Chats",
  terminals: "Terminals",
  settings: "Settings",
  config: "Config",
  emptyMachines: "No machines yet. Add one in Settings.",
  emptyChats: "No chats yet. Start an agent in a terminal and it shows up here.",
  emptyTerminals: "No terminals found on this machine.",
  emptyOpen: "Nothing open on this device yet.",
  sessionGone: "This session has ended. Pick another one from the menu.",
  machineUp: "Connected",
  machineConnecting: "Connecting…",
  machineDown: "Can't reach it",
  expand: "Show",
  collapse: "Hide",
  viewFailed: "Couldn't open this screen. Reload the page to try again.",
  pageUnknown: "That page doesn't exist. Taking you to the inbox.",

  // ---- Status words (dot names; the dot is never the only signal) ----
  status: {
    "needs-you": "needs you",
    working: "working",
    done: "done",
    idle: "idle",
    unknown: "unknown",
  },
  liveVoiceOn: "live voice on",

  // ---- Errors from the machine link (what happened, then what to do) ----
  apiUnreachable: "Couldn't reach the machine. Check that it is on and connected, then try again.",
  apiTimedOut: "The machine took too long to answer. Try again in a moment.",
  apiRefused: "The machine turned this device away. Check that this device is allowed to use Porthole there.",
  apiNotFound: "That isn't there any more. Refresh the list and try again.",
  apiServer: "Something went wrong on the machine. Try again in a moment.",
  apiBadReply: "The machine sent back something Porthole couldn't read. Try again in a moment.",
  apiTooBig: "That file is too big to send. Pick a smaller one.",

  // ---- Chat ----
  showEarlier: "Show earlier",
  newMessages: "New messages ↓",
  saidAtDesk: "Said at the desk",
  you: "You",
  agent: "Agent",
  chatEmpty: "No messages yet. Write one below to start.",
  chatFailed: "Couldn't load this chat. Check the connection and try again.",
  toolsUsed: "Tools used",
  openInTerminal: "Open in terminal",
  openChat: "Open chat",
  changes: "Changes",
  previews: "Previews",
  usage: "Usage",

  // ---- Composer ----
  messageLabel: "Message",
  messagePlaceholder: "Write a message",
  send: "Send",
  sending: "Sending…",
  talk: "Talk",
  attach: "Attach",
  takePhoto: "Take a photo",
  choosePhoto: "Choose a photo",
  chooseFile: "Choose a file",
  pasteImage: "Paste image",
  uploading: "Uploading…",
  uploadFailed: "Couldn't upload that file. Check the connection and try again.",
  sentMessages: "Sent messages",
  sentEmpty: "Nothing sent from this chat yet. Messages you send show up here.",
  copyText: "Copy",
  copied: "Copied.",
  putBack: "Put back in the box",
  sentStatus: {
    delivered: "Delivered",
    pending: "Waiting",
    held: "Not sent yet",
    refused: "Not accepted",
    failed: "Couldn't send",
  },

  // ---- Key row ----
  keyRow: "Keys",
  keys: { Esc: "Esc", Up: "↑", Down: "↓", Left: "←", Right: "→", Enter: "Enter", Tab: "Tab", Stop: "Stop" },
  keyNames: { Esc: "Escape", Up: "Up arrow", Down: "Down arrow", Left: "Left arrow", Right: "Right arrow", Enter: "Enter", Tab: "Tab", Stop: "Stop the agent" },
  prefixTerminalOnly: "This shortcut works in the terminal only.",
  keyFailed: "Couldn't send that key. Check the connection and try again.",

  // ---- Terminal ----
  terminalKeys: "Terminal keys",
  ctrl: "Ctrl",
  ctrlLocked: "Ctrl locked",
  keyboard: "Keyboard",
  paste: "Paste",
  shortcuts: "Shortcuts",
  shortcutsEmpty: "No shortcuts saved on this machine yet. Add some in Config.",
  smallerText: "Smaller text",
  biggerText: "Bigger text",
  terminalReadOnly: "This terminal is view-only right now.",
  terminalFailed: "Couldn't open this terminal. Check the connection and try again.",
  terminalClosed: "This terminal has ended. Pick another one from the menu.",
  pasteFailed: "Couldn't paste. Allow pasting for this page and try again.",

  // ---- Inbox ----
  sectionNeedsYou: "Needs you",
  sectionWorking: "Working",
  sectionDone: "Done",
  more: "More",
  less: "Less",
  stop: "Stop",
  archive: "Archive",
  archived: "Archived",
  archivedEmpty: "Nothing archived.",
  swipeToArchive: "Swipe left to archive",
  otherAnswer: "Other answer",
  answerPlaceholder: "Type your answer",
  sendAnswer: "Send answer",
  openTerminal: "Open terminal",
  answerFailed: "Couldn't send your answer. Check the connection and try again.",
  stopFailed: "Couldn't stop it. Try again, or stop it at the desk.",
  archiveFailed: "Couldn't archive that. Try again in a moment.",
  inboxFailed: "Couldn't load the inbox. Check the connection and try again.",

  // ---- Changes (diff) ----
  staged: "Staged",
  notStaged: "Not staged",
  newFiles: "New files",
  binaryFile: "Binary file, not shown",
  noChanges: "No changes in this repo.",
  diffFailed: "Couldn't read the changes. Try again in a moment.",
  fileStatus: {
    A: "Added",
    M: "Modified",
    D: "Deleted",
    R: "Renamed",
    C: "Copied",
    T: "Type changed",
    U: "Conflict",
    "?": "New",
  },

  // ---- Previews and usage ----
  previewsTitle: "Previews",
  previewOpen: "Open",
  previewsEmpty: "Nothing is running that you can preview. Start a dev server and it shows up here.",
  previewsFailed: "Couldn't look for previews. Try again in a moment.",
  usageTitle: "Usage",
  usageFiveHours: "5 hours",
  usageSevenDays: "7 days",
  usageNotRead: "Usage hasn't been read yet. It shows up here once the machine has checked.",

  // ---- Talk mode and read-aloud ----
  talkTitle: "Talk",
  talkStart: "Start talking",
  talkStopRecording: "Stop recording",
  talkListening: "Listening…",
  talkWorking: "Turning your words into text…",
  talkMicDenied: "Porthole can't use the microphone. Allow microphone access for this page, then try again.",
  voiceFailed: "Couldn't turn your recording into text. Try again, or type your message instead.",
  stopReading: "Stop reading",
  readAll: "Read all",

  // ---- Settings (this device) ----
  settingsTitle: "Settings",
  textSize: "Text size",
  terminalTextSize: "Terminal text",
  chatTextSize: "Chat text",
  textSizePreview: "This is how your text will look.",
  talkMode: "Talk mode",
  talkAutoSend: "Send automatically after I speak",
  talkAutoStop: "Stop recording after 2 seconds of silence",
  readAloud: "Read replies aloud",
  gestures: "Gestures",
  gesturesIntro: "Choose what each touch gesture does in a terminal.",
  resetGestures: "Reset gestures",
  windowSwipeNote: "Also changes the window on the computer's screen",
  gestureNames: {
    "swipe1-left": "Swipe left with one finger",
    "swipe1-right": "Swipe right with one finger",
    "swipe2-left": "Swipe left with two fingers",
    "swipe2-right": "Swipe right with two fingers",
    "swipe2-up": "Swipe up with two fingers",
    "swipe2-down": "Swipe down with two fingers",
    "pinch-out": "Spread two fingers apart",
    "pinch-in": "Pinch two fingers together",
    "double-tap": "Double tap",
    drag: "Drag one finger up or down",
  },
  gestureActions: {
    "window-next": "Next window or tab",
    "window-prev": "Previous window or tab",
    "pane-next": "Next pane",
    "pane-prev": "Previous pane",
    "session-next": "Next session or workspace",
    "session-prev": "Previous session or workspace",
    "text-bigger": "Bigger text",
    "text-smaller": "Smaller text",
    paste: "Paste",
    scroll: "Scroll back",
    none: "Nothing",
  },
  tmuxPrefix: "Prefix key for tmux",
  tmuxPrefixHelp: "The key you press before a tmux command. Usually C-b.",
  machinesTitle: "Machines",
  addMachine: "Add a machine",
  machineName: "Machine name",
  add: "Add",
  remove: "Remove",
  machinesReadOnly: "Change machines in the app's settings",
  machineExists: "That machine is already in the list.",
  machineNameInvalid: "Use letters, numbers and dashes only.",
  notifications: "Notifications",
  notificationSettings: "Open notification settings",
  voiceKept: "Voice recordings kept",

  // ---- Config (per machine) and checks ----
  shortcutsEditor: "Shortcuts",
  shortcutAdd: "Add a shortcut",
  shortcutLabel: "Name",
  shortcutSteps: "Steps",
  shortcutStepsHelp: "Separate steps with commas. Example: C-c, text:echo done\\, ok, Enter",
  shortcutPreview: "Preview",
  shortcutSave: "Save",
  shortcutRemove: "Remove",
  shortcutSaved: "Saved.",
  shortcutSaveFailed: "Couldn't save your shortcuts. Check the connection and try again.",
  hostSettings: "Settings on this machine",
  configSaved: "Saved.",
  configSaveFailed: "Couldn't save the settings. Check the connection and try again.",
  configFailed: "Couldn't load the settings. Check the connection and try again.",
  configLabels: {
    previewRanges: "Ports to look at for previews",
    usageCollection: "Read usage on this machine",
    peers: "Other machines to link",
    voiceEnhance: "Tidy up spoken text",
  },
  doctorTitle: "Checks",
  doctorOk: "Working",
  doctorBad: "Needs attention",
  doctorFailed: "Couldn't run the checks. Check the connection and try again.",
  doctorNone: "No checks to show.",
  checkAgain: "Check again",
  doctorLabel: (/** @type {string | number} */ id) => {
    const s = String(id);
    if (s.startsWith("tmux-mouse:")) return `Scrolling in tmux (${s.slice("tmux-mouse:".length).split("/").pop()})`;
    /** @type {Record<string, string>} */
    const names = {
      "extension:porthole-events": "omp extension: events",
      "extension:live-inbox": "omp extension: inbox",
      "events-socket": "Live events channel",
      voxtype: "Voice typing",
      git: "git",
      "state-dir": "Porthole's saved files",
    };
    return names[s] ?? s;
  },
  labelTooLong: (/** @type {string | number} */ max) => `Keep the name to ${max} characters or fewer.`,
  labelTaken: "You already have a shortcut with that name. Pick another name.",
  editShortcut: "Edit",
  cancel: "Cancel",
  rangesHelp: "Port ranges such as 3000-3999, 5173, or none to turn previews off.",
  peersHelp: "One address per line, for example https://laptop.example.ts.net. A change here needs a restart of Porthole on this machine.",
  prefixInvalid: "Use one key, such as C-b or C-a.",
  machineSaveFailed: "Couldn't save the machine list on this device. Try again.",
  notificationsFailed: "Couldn't open the notification settings. Try again.",
  scaleValue: (/** @type {number | string} */ s) => `${Math.round(Number(s) * 1000) / 10} %`,
});
