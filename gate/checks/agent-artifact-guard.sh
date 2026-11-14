#!/usr/bin/env bash
# Falha quando artefatos locais de agente ou de build estão versionados.
set -euo pipefail
blocked_regex='(^|/)(\.codex|\.claude/worktrees|\.worktrees|\.design-extract|node_modules|vendor|dist|coverage|var/cache|var/log)(/|$)|(^|/).*\.zip$'
if git ls-files | grep -E "$blocked_regex"; then
  echo "::error::Artefatos locais de agente ou de build estão versionados. Remova-os do commit."
  exit 1
fi
echo "agent-artifact-guard: nenhum artefato versionado"
