// web/test/e2e/share.test.ts
// A file shared to the Android app reaches the page as a native `share` event, possibly before any chat is open. The page keeps it
// until a message box listens, and with no chat open asks which chat should get it. The native side is simulated in the page: it
// answers every call with nothing and, when the page installs its listener, sends the share named in sessionStorage.__share.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startStack, type Stack } from "./stack";

const NATIVE = `(() => {
  let listener = null;
  window.PortholeNative = {
    postMessage(text) {
      const call = JSON.parse(text);
      setTimeout(() => listener && listener({ data: JSON.stringify({ id: call.id, ok: true, result: null }) }), 0);
    },
    get onmessage() { return listener; },
    set onmessage(fn) {
      listener = fn;
      const path = sessionStorage.getItem("__share");
      if (path) setTimeout(() => fn({ data: JSON.stringify({ event: "share", data: { path } }) }), 0);
    },
  };
})();`;

const box = `document.querySelector("[data-test=composer] textarea")`;
const A = "/tmp/porthole-share-test/a.png";
const B = "/tmp/porthole-share-test/b.png";
let chatHash = "";

let st: Stack;
beforeAll(async () => {
  st = await startStack({ fixtures: { desk: ["chat-p3.jsonl"], laptop: [] } });
  await st.page.onNewDocument(NATIVE);
  await st.page.phone();
  chatHash = st.chatUrl("desk", "chat-p3.jsonl").slice("https://testdesk.example.ts.net/".length);
});
afterAll(async () => { await st?.stop(); });

/** Opens the app afresh (a hash-only goto would keep the old document and its already-installed listener). */
async function open(hash: string, share: string) {
  await st.page.eval(`sessionStorage.setItem("__share", ${JSON.stringify(share)})`);
  await st.page.goto(`https://testdesk.example.ts.net/${hash}`);
  await st.page.waitFor(`location.hash === ${JSON.stringify(hash)}`, 5000); // a hash-only goto commits a moment later; reloading before that reloads the old address
  await st.page.reload();
}

test("a share that arrives with the app on the Inbox asks which chat gets it; the chosen chat's message box receives the path", async () => {
  await open("#/inbox", A);
  await st.page.waitFor(`document.querySelector("[data-test=share-picker] [data-test=share-chat]")`, 15000);
  expect(await st.page.eval(`document.querySelector("[data-test=share-picker] [role=dialog]").innerText`)).toContain("Choose a chat for this file");
  expect(await st.page.eval(`document.querySelectorAll("[data-test=share-picker] script, [data-test=share-picker] [onerror]").length`)).toBe(0);
  expect(await st.page.eval(`!!document.querySelector("[data-test=composer]")`)).toBe(false); // no chat is open yet
  await st.page.click("[data-test=share-picker] [data-test=share-chat]");
  await st.page.waitFor(`location.hash.startsWith("#/chat/")`, 10000);
  await st.page.waitFor(`${box}?.value.includes(${JSON.stringify(A)})`, 15000);
  expect(await st.page.eval(`!!document.querySelector("[data-test=share-picker]")`)).toBe(false);
});

test("a share that arrives before the chat's message box exists waits and lands in it, after the restored draft", async () => {
  await open(chatHash, B);
  await st.page.waitFor(`${box}?.value.includes(${JSON.stringify(B)})`, 15000);
  const text: string = await st.page.eval(`${box}.value`);
  expect(text.split("\n").filter((l) => l.trim() !== "")).toEqual([A, B]);
  expect(await st.page.eval(`!!document.querySelector("[data-test=share-picker]")`)).toBe(false);
});
test("Not now closes the sheet, and the file waits for the next chat that opens", async () => {
  const C = "/tmp/porthole-share-test/c.png";
  await open("#/inbox", C);
  await st.page.waitFor(`document.querySelector("[data-test=share-picker]")`, 15000);
  await st.page.click("[data-test=share-dismiss]");
  expect(await st.page.eval(`!!document.querySelector("[data-test=share-picker]")`)).toBe(false);
  expect(await st.page.eval(`!!document.querySelector("[data-test=composer]")`)).toBe(false);
  await st.page.eval(`location.hash = ${JSON.stringify(chatHash)}`);
  await st.page.waitFor(`${box}?.value.includes(${JSON.stringify(C)})`, 15000);
});
