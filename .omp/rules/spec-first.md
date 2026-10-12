---
alwaysApply: true
description: Porthole is built from docs/SPEC.md; its section 7 safety rules are mandatory.
---

Build only what `docs/SPEC.md` describes. Its section 7 ("Safety rules for the build itself") is
mandatory for every agent working here: scratch tmux sockets only, no live voice, no adb screenshot
loops, exact-PID kills only, no secrets. The remote is the private repo CymaticStatic/porthole; never
change its visibility.

Decisions Ben settled in the spec (talk mode approach A, summary-only read-aloud) are fixed; do not
change them without Ben.
