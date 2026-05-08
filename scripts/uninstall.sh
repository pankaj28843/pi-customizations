#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
agent_dir=${PI_CODING_AGENT_DIR:-"$HOME/.pi/agent"}
case "$agent_dir" in
  "~") agent_dir="$HOME" ;;
  "~/"*) agent_dir="$HOME/${agent_dir#~/}" ;;
esac
extension_name=${PI_CUSTOMIZATIONS_EXTENSION_NAME:-pi-customizations}
install_link="$agent_dir/extensions/$extension_name"

if [[ ! -L "$install_link" ]]; then
  echo "Nothing to uninstall: $install_link is not a symlink."
  exit 0
fi

current_target=$(readlink -f "$install_link")
if [[ "$current_target" != "$repo_root" ]]; then
  echo "error: refusing to remove $install_link; it points to $current_target, not $repo_root" >&2
  exit 1
fi

rm "$install_link"
echo "Removed $install_link"
