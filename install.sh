#!/usr/bin/env bash
#
# dsh-peer one-shot installer.
#
# Installs the three pieces that must live outside this repository:
#   1. the peer CLI            -> ~/lib/dsh-peer + ~/bin/peer (+ ~/.local/bin/peer if present)
#   2. the skill for both      -> ~/.claude/skills/cross-harness-peer and ~/.codex/skills/cross-harness-peer
#   3. the DSH plugin bundle   -> the DSH profile you boot (default: desktop)
#
# Run it yourself in a normal Terminal: the DSH agent's file sandbox is
# workspace-only, so it cannot run the profile's package manager for you.
#
# Usage:
#   bash install.sh                    # install into the booted-looking profile "desktop"
#   bash install.sh --profile web      # install into another profile
#   bash install.sh --dry-run          # show what would happen; write nothing
#   bash install.sh --skip-plugin      # CLI + skills only
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${DSH_PROFILE:-desktop}"
DRY_RUN=0
SKIP_PLUGIN=0
PASSTHRU=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      PROFILE="${2:?--profile needs a name}"
      shift 2
      ;;
    --profile=*)
      PROFILE="${1#*=}"
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      PASSTHRU+=("$1")
      shift
      ;;
    --skip-plugin)
      SKIP_PLUGIN=1
      shift
      ;;
    -h|--help)
      sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      PASSTHRU+=("$1")
      shift
      ;;
  esac
done

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
ok()  { printf '    ok  %s\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }

say "dsh-peer installer"
echo "    repo     $SCRIPT_DIR"
echo "    profile  $PROFILE"
echo "    dry run  $([ "$DRY_RUN" -eq 1 ] && echo yes || echo no)"
echo

# --- 0. prerequisites -------------------------------------------------------
command -v node >/dev/null 2>&1 || die "node is not on PATH; install Node.js >= 20 first"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js >= 20 is required (found $(node -v))"
ok "node $(node -v)"

if [ "$DRY_RUN" -eq 0 ]; then
  command -v dsh >/dev/null 2>&1 || echo "    note  'dsh' CLI not on PATH; the plugin step will fail (use --skip-plugin)"
  [ -f "$SCRIPT_DIR/package.json" ] || die "run this from the dsh-peer checkout (package.json missing)"
fi

# --- 1+2. CLI and skills ----------------------------------------------------
say "Installing the peer CLI and the Claude Code / Codex skills"
node "$SCRIPT_DIR/scripts/install-skill.mjs" "${PASSTHRU[@]+"${PASSTHRU[@]}"}"
echo

if [ "$DRY_RUN" -eq 1 ]; then
  say "Dry run: plugin step would run"
  echo "    dsh plugin --profile $PROFILE add \"link:$SCRIPT_DIR\""
  exit 0
fi

# Put the launcher on a PATH directory that already exists, when possible.
if [ -d "$HOME/.local/bin" ] && [ -x "$HOME/bin/peer" ]; then
  ln -sfn "$HOME/bin/peer" "$HOME/.local/bin/peer"
  ok "linked ~/.local/bin/peer -> ~/bin/peer"
fi
if command -v peer >/dev/null 2>&1; then
  ok "peer resolves to $(command -v peer)"
else
  echo "    note  ~/bin is not on PATH in this shell; add: export PATH=\"\$HOME/bin:\$PATH\""
fi
echo

# --- 3. DSH plugin ----------------------------------------------------------
if [ "$SKIP_PLUGIN" -eq 1 ]; then
  say "Skipping the DSH plugin step (--skip-plugin)"
else
  PROFILE_DIR="${DSH_HOME:-$HOME/.dsh}/profiles/$PROFILE"
  [ -f "$PROFILE_DIR/package.json" ] || die "no DSH profile at $PROFILE_DIR; pass --profile <name>"
  say "Adding @caelricluo/dsh-peer to the '$PROFILE' DSH profile"
  if node -e '
    const fs = require("node:fs");
    const p = process.argv[1];
    const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
    const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
    process.exit(bundles.includes("@caelricluo/dsh-peer") ? 0 : 1);
  ' "$PROFILE_DIR/package.json"; then
    ok "already present in $PROFILE_DIR/package.json"
  else
    dsh plugin --profile "$PROFILE" add "link:$SCRIPT_DIR"
    node -e '
      const fs = require("node:fs");
      const p = process.argv[1];
      const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
      const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
      if (!bundles.includes("@caelricluo/dsh-peer")) {
        console.error("install: plugin add finished but the bundle is not listed in " + p);
        process.exit(1);
      }
      console.log("    ok  bundle listed: " + bundles.filter((b) => b.includes("dsh-peer")).join(", "));
    ' "$PROFILE_DIR/package.json"
  fi
  echo
fi

# --- 4. What happens next ---------------------------------------------------
cat <<'NEXT'
Next steps:
  1. Quit and reopen the DeepSeek Harness app so the profile recomposes and the
     plugin mounts (the bridge starts with the app).
  2. Start Claude Code / Codex once so they pick up the new skill.
  3. Verify from a terminal:
         peer doctor          # discovery + token + adapters
         peer status --json   # harnesses, models, live DSH sessions
     Expected: bridge reachable, adapters dsh:true and claude:true/codex:true
     depending on which CLIs are installed.
NEXT
