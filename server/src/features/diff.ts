// GET /v1/sessions/:id/diff: what changed in the session's folder (SPEC 4.9).

import { changes } from "../diff/diff";
import { json, type FeatureFactory } from "../router";

export const diffFeature: FeatureFactory = (d) => ({
  routes: [
    {
      method: "GET",
      pattern: "/v1/sessions/:id/diff",
      async handler(_req, params, ctx) {
        ctx.session = params.id;
        const info = await d.registry.get(params.id, 0);
        if (!info) return json({ error: "no such session" }, 404);
        return json(await changes(d.config, info.cwd));
      },
    },
  ],
  channels: [],
});
