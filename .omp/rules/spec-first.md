---
alwaysApply: true
description: Porthole is built from docs/SPEC.md; its section 7 safety rules are mandatory.
---

Build only what `docs/SPEC.md` describes. Its section 7 ("Safety rules for the build itself") is
mandatory for every agent working here: scratch tmux sockets only, no live voice, no adb screenshot
loops, exact-PID kills only, no secrets, and ask Ben before creating a GitHub remote.

Choices marked **ASSUMED** in the spec are built as written; do not change them without Ben.
