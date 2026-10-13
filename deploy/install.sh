#!/usr/bin/env bash
# Install the committed HEAD of this repo as the porthole user service. Needs no root (SPEC 7).
#   deploy/install.sh            snapshot + unit file + daemon-reload
#   deploy/install.sh --enable   the same, then enable and start the service (only after Ben's yes)
set -euo pipefail
repo="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
sha="$(git -C "$repo" rev-parse --short HEAD)"
root="$HOME/.local/share/porthole/hostd"
mkdir -p "$root/$sha"
git -C "$repo" archive HEAD | tar -x -C "$root/$sha"
ln -sfn "$root/$sha" "$root/current"
mkdir -p "$HOME/.config/systemd/user"
install -m 0644 "$repo/deploy/porthole.service" "$HOME/.config/systemd/user/porthole.service"
systemctl --user daemon-reload
if [ "${1:-}" = "--enable" ]; then
  systemctl --user enable --now porthole.service
fi
echo "installed $sha into $root/current"
