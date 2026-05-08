#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
agent_dir=${PI_CODING_AGENT_DIR:-"$HOME/.pi/agent"}
case "$agent_dir" in
  "~") agent_dir="$HOME" ;;
  "~/"*) agent_dir="$HOME/${agent_dir#~/}" ;;
esac
extension_name=${PI_CUSTOMIZATIONS_EXTENSION_NAME:-pi-customizations}
extensions_dir="$agent_dir/extensions"
install_link="$extensions_dir/$extension_name"

mkdir -p "$extensions_dir"

if [[ -e "$install_link" && ! -L "$install_link" ]]; then
  echo "error: $install_link exists and is not a symlink" >&2
  echo "Move it away, or set PI_CUSTOMIZATIONS_EXTENSION_NAME to install under a different name." >&2
  exit 1
fi

if [[ -L "$install_link" ]]; then
  rm "$install_link"
fi
ln -s "$repo_root" "$install_link"

echo "Installed pi-customizations extension symlink:"
echo "  $install_link -> $repo_root"
echo "Restart pi or run /reload in an existing pi session."
