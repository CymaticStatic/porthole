import { expect, test } from "bun:test";
import { copy } from "../../src/lib/copy.js";
import { phoneSettingsLinks } from "../../src/lib/phonesettings.js";

test("a plain browser (no app bridge, or a bridge that is not there) shows no phone settings", () => {
  expect(phoneSettingsLinks(null, copy)).toEqual([]);
  expect(phoneSettingsLinks(undefined, copy)).toEqual([]);
  expect(phoneSettingsLinks({ available: false }, copy)).toEqual([]);
  expect(phoneSettingsLinks({}, copy)).toEqual([]);
});

test("inside the app there are exactly two buttons, each opening one native screen, in plain words", () => {
  const links = phoneSettingsLinks({ available: true }, copy);
  expect(links.map((l) => [l.screen, l.label])).toEqual([
    ["machines", "Computers this phone connects to"],
    ["battery", "Keep Porthole running"],
  ]);
  expect(new Set(links.map((l) => l.test)).size).toBe(2);
  expect(copy.phoneSettings).toBe("Phone settings");
});
