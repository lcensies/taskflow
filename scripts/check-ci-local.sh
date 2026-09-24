#!/usr/bin/env bash
# Typecheck + tests, ignoring the 6 known env-specific failures on this NixOS box
# (nix-wrapped `pi` bin, symlinked /etc/hosts). Any other failure fails the script.
set -o pipefail
pnpm run typecheck || exit 1
log=$(mktemp)
pnpm test >"$log" 2>&1
grep -E '^✖ ' "$log" | sed 's/ ([0-9.]*ms)$//' | sort -u \
  | grep -vE '^✖ (failing tests:|mcp: defineFile cannot escape cwd or the OS temp directory|getPiInvocation: )' \
  && { echo "UNEXPECTED FAILURES (see $log)"; exit 1; }
grep -E '^ℹ (pass|fail) ' "$log"
