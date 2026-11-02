#!/usr/bin/env bash
# Builds Fork from source and launches it with a fake local model, so chat (Cmd+L) and
# inline edits (Cmd+I) can be tried with no API key.
#
#   bash fork/dev/try-fork.sh            first run: install, compile, launch (takes a while)
#   bash fork/dev/try-fork.sh --rebuild  recompile everything after pulling new commits
#
# Output is also written to .build/try-fork.log.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
mkdir -p .build
exec > >(tee .build/try-fork.log) 2>&1

export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
PORT=11999

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*"; exit 1; }

step "Checking tools"
if [[ "$OSTYPE" == darwin* ]] && ! xcode-select -p >/dev/null 2>&1; then
	fail "Xcode command line tools are missing. Run: xcode-select --install   then run this script again."
fi
REQUIRED="$(tr -d '[:space:]' < .nvmrc)"
MAJOR="${REQUIRED%%.*}"
NVM_SH="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
if [ -s "$NVM_SH" ]; then
	set +u
	# shellcheck disable=SC1090
	. "$NVM_SH"
	nvm install "$REQUIRED" >/dev/null && nvm use "$REQUIRED" >/dev/null
	set -u
fi
command -v node >/dev/null || fail "Node.js is not installed. Install Node $REQUIRED (nvm is easiest: https://github.com/nvm-sh/nvm), then run this script again."
HAVE="$(node -p 'process.versions.node')"
[ "${HAVE%%.*}" = "$MAJOR" ] || fail "Fork needs Node $REQUIRED; this shell has $HAVE. With nvm: nvm install $REQUIRED"
if ! command -v pnpm >/dev/null; then
	command -v corepack >/dev/null || fail "pnpm and corepack are both missing; corepack ships with Node. Reinstall Node $REQUIRED."
	# The repo's scripts call `pnpm` by name, so put a corepack-backed pnpm on PATH for this run.
	SHIM="$ROOT/.build/pnpm-shim"
	mkdir -p "$SHIM"
	printf '#!/bin/sh\nexec corepack pnpm "$@"\n' > "$SHIM/pnpm"
	chmod +x "$SHIM/pnpm"
	export PATH="$SHIM:$PATH"
fi
PNPM=(pnpm)
echo "node $HAVE · pnpm $("${PNPM[@]}" --version) · $(uname -sm)"

if [ ! -d node_modules ]; then
	step "Installing dependencies (several minutes the first time)"
	PNPM_CONFIG_FROZEN_LOCKFILE=true "${PNPM[@]}" install --frozen-lockfile
fi

step "Getting Electron"
"${PNPM[@]}" run electron

if [ ! -d out ] || [ "${1:-}" = "--rebuild" ]; then
	step "Compiling Fork (10 to 20 minutes the first time)"
	"${PNPM[@]}" run compile
fi

step "Building Fork AI"
node extensions/fork-ai/esbuild.mts
node extensions/fork-ai/esbuild.webview.mts

step "Starting the fake model at http://127.0.0.1:$PORT/v1"
node fork/dev/fake-model-server.mjs "$PORT" > .build/fork-fake-model.log 2>&1 &
FAKE_PID=$!
trap 'kill "$FAKE_PID" 2>/dev/null || true' EXIT
sleep 1
kill -0 "$FAKE_PID" 2>/dev/null || fail "The fake model did not start; see .build/fork-fake-model.log (is port $PORT in use?)"

cat <<EOF

Fork is starting. To try it:
  1. Cmd+L opens the chat. Click "Add a model" and choose "Custom endpoint".
  2. URL: http://127.0.0.1:$PORT/v1 · format: OpenAI-compatible · key: leave empty · model: fake-coder
  3. Ask something in chat. Select code in src/dates.ts, press Cmd+I and describe a change.
Close the Fork window to stop.
EOF

step "Launching Fork"
./scripts/code.sh "$ROOT/fork/dev/sample-project"
