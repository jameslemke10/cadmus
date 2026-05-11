#!/usr/bin/env bash
#
# Cadmus installer.
#
#   curl -fsSL https://raw.githubusercontent.com/jameslemke10/cadmus/main/install.sh | bash
#
# Env:
#   CADMUS_HOME  Workspace location (default: ~/.cadmus)
#   CADMUS_REF   Git ref to install (default: main)

set -euo pipefail

CADMUS_HOME="${CADMUS_HOME:-$HOME/.cadmus}"
CLI_DIR="$CADMUS_HOME/cli"
AGENTS_DIR="$CADMUS_HOME/agents"
CADMUS_REF="${CADMUS_REF:-main}"
REPO_URL="https://github.com/jameslemke10/cadmus.git"

bold()   { printf "\033[1m%b\033[0m" "$1"; }
green()  { printf "\033[32m%b\033[0m" "$1"; }
yellow() { printf "\033[33m%b\033[0m" "$1"; }
red()    { printf "\033[31m%b\033[0m" "$1"; }
dim()    { printf "\033[2m%b\033[0m" "$1"; }

# spin <message> -- <command...>
# Runs the command in the background and shows a single-line spinner with
# elapsed seconds. On success replaces the spinner with a green check + time;
# on failure prints the tail of the captured log and exits.
spin() {
  local msg="$1"
  shift
  local logfile
  logfile="$(mktemp -t cadmus-install.XXXXXX)"
  ("$@" >"$logfile" 2>&1) &
  local pid=$!
  local chars='|/-\'
  local i=0
  local start_ts
  start_ts="$(date +%s)"
  # Hide cursor while spinning.
  printf '\033[?25l'
  while kill -0 "$pid" 2>/dev/null; do
    local elapsed=$(($(date +%s) - start_ts))
    printf '\r  %s %s \033[2m(%ds)\033[0m\033[K' \
      "${chars:$((i % 4)):1}" "$msg" "$elapsed"
    i=$((i + 1))
    sleep 0.1
  done
  # Restore cursor.
  printf '\033[?25h'
  wait "$pid"
  local code=$?
  local total=$(($(date +%s) - start_ts))
  if [ "$code" -eq 0 ]; then
    printf '\r  \033[32m✓\033[0m %s \033[2m(%ds)\033[0m\033[K\n' \
      "$msg" "$total"
    rm -f "$logfile"
  else
    printf '\r  \033[31m✗\033[0m %s \033[2m(failed after %ds)\033[0m\033[K\n\n' \
      "$msg" "$total"
    echo '  --- last 30 lines of output ---'
    tail -30 "$logfile" >&2
    echo
    echo "  full log: $logfile"
    exit "$code"
  fi
}

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    red "✗ $1 not found.\n"
    echo "  Install $1 (https://${2}) and re-run."
    exit 1
  fi
}

echo
bold "  cadmus\n"
echo "  An open-source framework for building AI agents."
echo "  https://github.com/jameslemke10/cadmus"
echo

require git "git-scm.com"
require node "nodejs.org"
require npm "npmjs.com"

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 20 ]; then
  red "✗ Node $NODE_MAJOR is too old.\n"
  echo "  Cadmus needs Node 20 or newer."
  exit 1
fi

echo "  Installing to: $CADMUS_HOME"
echo

# 1. Clone or update the framework into ~/.cadmus/cli/
if [ -d "$CLI_DIR/.git" ]; then
  spin "Updating framework" \
    bash -c "git -C '$CLI_DIR' fetch --quiet origin '$CADMUS_REF' && git -C '$CLI_DIR' checkout --quiet '$CADMUS_REF' && git -C '$CLI_DIR' pull --quiet --ff-only origin '$CADMUS_REF'"
else
  spin "Cloning framework" \
    git clone --quiet --depth 1 --branch "$CADMUS_REF" "$REPO_URL" "$CLI_DIR"
fi

cd "$CLI_DIR"

spin "Installing dependencies (first run takes ~30s)" \
  npm install --silent --no-fund --no-audit

spin "Building kernel, tools, and CLI" \
  npm run build --silent

# 2. Seed default agents under ~/.cadmus/agents/ (if not already present).
mkdir -p "$AGENTS_DIR"
seed_agent() {
  local example_name="$1"
  local agent_name="$2"
  local example_dir="$CLI_DIR/examples/$example_name"
  local target_dir="$AGENTS_DIR/$agent_name"
  if [ -d "$target_dir" ]; then
    dim "    ↩ $agent_name already installed\n"
    return
  fi
  if [ ! -d "$example_dir" ]; then
    dim "    ⚠ example $example_name not found in repo, skipping\n"
    return
  fi
  mkdir -p "$target_dir"
  cp "$example_dir/cadmus.config.ts" "$target_dir/cadmus.config.ts"
  [ -f "$example_dir/README.md" ] && cp "$example_dir/README.md" "$target_dir/README.md"
  mkdir -p "$target_dir/node_modules/@cadmus"
  ln -sfn "$CLI_DIR/packages/kernel" "$target_dir/node_modules/@cadmus/kernel"
  if [ -d "$CLI_DIR/packages/tools" ]; then
    ln -sfn "$CLI_DIR/packages/tools" "$target_dir/node_modules/@cadmus/tools"
  fi
  green "    ✓ installed $agent_name\n"
}

echo "  → Installing default agents…"
seed_agent "cadmus" "cadmus"
seed_agent "claudius" "claudius"
seed_agent "telly" "telly"

# 3. If no config.json yet, set active agent to cadmus.
if [ ! -f "$CADMUS_HOME/config.json" ]; then
  cat > "$CADMUS_HOME/config.json" <<EOF
{
  "activeAgent": "cadmus",
  "apiKeys": {}
}
EOF
fi

# 4. Link the cadmus command. Prefer dirs already on PATH.
LINK_TARGET="$CLI_DIR/packages/cli/dist/cli.js"
chmod +x "$LINK_TARGET"

CANDIDATES=(
  "/opt/homebrew/bin"
  "/usr/local/bin"
  "$HOME/.local/bin"
)

linked=""
needs_path_warning=""
for d in "${CANDIDATES[@]}"; do
  if [ -d "$d" ] && [ -w "$d" ]; then
    ln -sf "$LINK_TARGET" "$d/cadmus"
    linked="$d/cadmus"
    case ":$PATH:" in
      *":$d:"*) ;;
      *) needs_path_warning="$d" ;;
    esac
    break
  fi
done

if [ -z "$linked" ]; then
  yellow "  ⚠ Could not auto-link the cadmus command.\n"
  echo "    Add this to your shell profile manually:"
  bold "      alias cadmus='$LINK_TARGET'\n"
elif [ -n "$needs_path_warning" ]; then
  green "  ✓ Linked: $linked\n"
  yellow "  ⚠ $needs_path_warning is not on your PATH.\n"
  echo "    Add this to your ~/.zshrc or ~/.bashrc:"
  bold "      export PATH=\"$needs_path_warning:\$PATH\"\n"
else
  green "  ✓ Linked: $linked  (on PATH)\n"
fi

echo
green "✓ Cadmus installed.\n"
echo
echo "  $(bold 'Next:') run $(bold 'cadmus setup') to add an API key,"
echo "  then $(bold 'cadmus start') to boot the active agent + Studio UI."
echo
echo "  Three example agents are ready:"
echo "    $(bold 'cadmus')    — flagship brain pipeline (hippocampus → thalamus → PFC → executor)"
echo "    $(bold 'claudius')  — single-LLM-loop agent (familiar shape)"
echo "    $(bold 'telly')     — Telegram-connected agent (paste a bot token in setup)"
echo
echo "  Switch between them with $(bold 'cadmus use <name>')."
echo
