// GET /v1/machine: who this machine is and who the caller is. Never lists sessions (SPEC 5.1).

import { existsSync } from "node:fs";
import { json, type FeatureFactory } from "../router";
import { VERSION } from "../version";

export const machineFeature: FeatureFactory = (d) => ({
  routes: [
    {
      method: "GET",
      pattern: "/v1/machine",
      handler(req, _params, ctx) {
        const forwardedFor = (req.headers.get("x-forwarded-for") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
        return json({
          name: d.config.machineName,
          version: VERSION,
          authMode: "127.0.0.1",
          you: { device: ctx.device, via: ctx.via, forwardedFor },
          features: {
            tmux: existsSync(d.config.bin.tmux),
            herdr: existsSync(d.config.bin.herdr),
            pactl: existsSync(d.config.bin.pactl),
            tailscale: existsSync(d.config.bin.tailscale),
          },
        });
      },
    },
  ],
  channels: [],
});
