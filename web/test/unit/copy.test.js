import { expect, test } from "bun:test";
import { copy } from "../../src/lib/copy.js";

const all = (o) => Object.values(o).flatMap((v) => (typeof v === "string" ? [v] : typeof v === "function" ? [String(v(2, "testlaptop"))] : all(v)));
const BANNED = /\b(WebSocket|PTY|HTTP|JSON|clientMsgId|origin|CORS|endpoint|payload|stdout|stderr|pane id|403|404|500|null|undefined|NaN)\b/i;

const frozenDeep = (o) => Object.isFrozen(o) && Object.values(o).every((v) => (v !== null && typeof v === "object" ? frozenDeep(v) : true));

test("the voice-table strings are exact", () => {
  expect(copy.reconnecting).toBe("Reconnecting…");
  expect(copy.reconnected).toBe("Connected again.");
  expect(copy.sendHeld).toBe("Not sent yet. Your message is saved and will go out when the connection is back.");
  expect(copy.sendFailedTitle).toBe("Couldn't send. Your message is still here.");
  expect(copy.pendingTitle).toBe("Waiting for the agent to pick it up. Your message is saved.");
  expect(copy.liveVoiceKeys).toBe("Live voice is on at the desk: keys go to the live panel (Space mutes, Esc ends it)");
  expect(copy.noRepo).toBe("No git repo here");
  expect(copy.answerInTerminal).toBe("Answer this in the terminal");
  expect(copy.inboxEmpty).toBe("Nothing needs you. New questions from your agents show up here.");
  expect(copy.draftSaveFailed).toBe("This device couldn't save your draft. Copy it somewhere safe before leaving.");
});
test("no technical words on screen", () => {
  for (const s of all(copy)) expect(`${s} ${BANNED.test(s)}`).toBe(`${s} false`);
});
test("errors say what happened and what to do (two sentences at least)", () => {
  for (const k of ["sendHeld", "sendFailedTitle", "draftSaveFailed", "viewFailed", "uploadFailed", "voiceFailed"]) expect(copy[k].split(/[.!?]\s/).length).toBeGreaterThanOrEqual(2);
});
test("plural forms", () => {
  expect([copy.needYou(1), copy.needYou(3)]).toEqual(["1 needs you", "3 need you"]);
});
test("the plan's labels are all there", () => {
  expect([copy.machines, copy.inbox, copy.chats, copy.terminals, copy.settings, copy.config]).toEqual(["Machines", "Inbox", "Chats", "Terminals", "Settings", "Config"]);
  expect([copy.keys.Stop, copy.ctrl, copy.ctrlLocked, copy.shortcuts, copy.smallerText, copy.biggerText]).toEqual(["Stop", "Ctrl", "Ctrl locked", "Shortcuts", "Smaller text", "Bigger text"]);
  expect([copy.takePhoto, copy.choosePhoto, copy.chooseFile, copy.pasteImage]).toEqual(["Take a photo", "Choose a photo", "Choose a file", "Paste image"]);
  expect([copy.stop, copy.archive, copy.sentMessages, copy.copyText, copy.putBack]).toEqual(["Stop", "Archive", "Sent messages", "Copy", "Put back in the box"]);
  expect([copy.linkChat, copy.linkTerminal]).toEqual(["Chat", "Terminal"]);
});
test("gesture actions have the plain names Settings shows, one per action", () => {
  const ids = ["window-next", "window-prev", "pane-next", "pane-prev", "session-next", "session-prev", "text-bigger", "text-smaller", "paste", "scroll", "none"];
  expect(Object.keys(copy.gestureActions)).toEqual(ids);
  expect(Object.values(copy.gestureActions)).toEqual(["Next window or tab", "Previous window or tab", "Next pane", "Previous pane", "Next session or workspace", "Previous session or workspace", "Bigger text", "Smaller text", "Paste", "Scroll back", "Nothing"]);
  expect(Object.keys(copy.gestureNames).sort()).toEqual(["double-tap", "drag", "pinch-in", "pinch-out", "swipe1-left", "swipe1-right", "swipe2-down", "swipe2-left", "swipe2-right", "swipe2-up"]);
});
test("strings with values", () => {
  expect(copy.cannotReach("testlaptop")).toBe("Can't reach testlaptop. It may be asleep or offline. Porthole keeps trying.");
  expect(copy.contextLeft(40)).toBe("40% of the context left");
  expect(copy.contextLeftWarn(12)).toBe("12% context left");
  expect(copy.answered("Large")).toBe("Answered: Large");
  expect(copy.restartNeeded("testdesk")).toBe("Saved. Restart Porthole on testdesk for this to take effect.");
});
test("hostd's reason becomes a capitalised sentence", () => {
  expect(copy.reasonLine("text steps work on tmux panes only; use Send for herdr")).toBe("Text steps work on tmux panes only; use Send for herdr.");
  expect(copy.reasonLine("Answer this in the terminal")).toBe("Answer this in the terminal.");
  expect(copy.reasonLine("  ")).toBe("");
});
test("plain voice: no exclamation marks, no Oops, nothing empty, nothing editable", () => {
  for (const s of all(copy)) {
    expect(s.length).toBeGreaterThan(0);
    expect(/!|\boops\b/i.test(s)).toBe(false);
  }
  expect(frozenDeep(copy)).toBe(true);
  expect(() => { "use strict"; copy.reconnecting = "x"; }).toThrow();
});
