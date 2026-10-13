---
alwaysApply: true
description: Porthole is built from docs/SPEC.md (v2); its section 7 safety rules are mandatory.
---

Build only what `docs/SPEC.md` describes. Its section 7 ("Safety rules for the build itself") is
mandatory for every agent working here: scratch tmux sockets and a fake herdr only, no live voice, no
adb screenshot loops, exact-PID kills only, no secrets, never restart tailscaled. Installs on Ben's
phone, watch or laptop need his OK at that moment. Android tooling goes into the home folder only, no
sudo. Zellij is out of scope. The remote is the private repo CymaticStatic/porthole; never change its
visibility.

Decisions Ben settled in the spec (section 10) are fixed; do not change them without Ben. Items
marked **ASSUMED** are built as written unless Ben changes them.
