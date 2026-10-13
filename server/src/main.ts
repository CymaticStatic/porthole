// hostd entry point (SPEC 5.1). Importing this file starts nothing; only running it does.
//   bun run server/src/main.ts init-config [--tailscale <path>]   write the first config (keeps an existing one)
//   bun run server/src/main.ts                                    run hostd until SIGTERM or SIGINT

import { homedir } from "node:os";
import path from "node:path";
import { defaultConfig, loadConfig, writeInitialConfig } from "./config";
import { createHostd, type Hostd } from "./hostd";
import { chatFeature } from "./features/chat";
import { machineFeature } from "./features/machine";
import { ptyFeature } from "./features/pty";
import { sendFeature } from "./features/send";
import { sessionsFeature } from "./features/sessions";
import type { FeatureFactory } from "./router";
import { VERSION } from "./version";

export const FEATURES: FeatureFactory[] = [machineFeature, sessionsFeature, chatFeature, sendFeature, ptyFeature];

/** `PORTHOLE_CONFIG` when set, else `<HOME>/.config/porthole/hostd.json`. */
export function configPath(env: Record<string, string | undefined> = process.env): string {
  if (env.PORTHOLE_CONFIG) return env.PORTHOLE_CONFIG;
  return path.join(env.HOME || homedir(), ".config", "porthole", "hostd.json");
}

async function initConfig(args: string[]): Promise<number> {
  const i = args.indexOf("--tailscale");
  const bin = i >= 0 ? args[i + 1] : undefined;
  if (i >= 0 && !bin) {
    console.error("--tailscale needs a path");
    return 1;
  }
  try {
    console.log(await writeInitialConfig(configPath(), bin ?? defaultConfig().bin.tailscale));
    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

async function serve(): Promise<void> {
  let h: Hostd;
  try {
    h = await createHostd(loadConfig(configPath()), FEATURES);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  console.log("porthole hostd " + VERSION + " on 127.0.0.1:" + h.port);
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      await h.stop();
    } catch (e) {
      console.error("hostd stop failed: " + (e instanceof Error ? e.message : String(e)));
      process.exit(1);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "init-config") process.exit(await initConfig(args.slice(1)));
  await serve();
}
