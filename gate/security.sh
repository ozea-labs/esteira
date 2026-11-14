#!/usr/bin/env bash
# Portão de segurança do repositório: guarda de artefatos, política de workflows, actionlint,
# zizmor, lockfile de actions, Gitleaks, Semgrep e OSV. Roda na raiz do repositório consumidor.
# Uso: gate/security.sh [arquivo de configuração]
source "$(dirname "$0")/lib.sh"
[ -n "${1:-}" ] && load_config "$1"
: "${GITLEAKS_CONFIG:=.gitleaks.toml}"
root="$(repo_root)"
cd "$root"

step "Guarda de artefatos de agente"
bash "$ESTEIRA_DIR/gate/checks/agent-artifact-guard.sh"
endstep

if [ -d .github/workflows ]; then
  step "Política de workflows (SHA, permissions, sem aviso, sem pull_request_target)"
  bash "$ESTEIRA_DIR/gate/checks/workflow-policy.sh" .github/workflows
  endstep

  step "actionlint"
  docker run --rm -v "$root:/repo:ro" -w /repo "$ACTIONLINT_IMAGE" -color
  endstep

  step "zizmor (bloqueante)"
  docker run --rm -v "$root:/repo:ro" "$ZIZMOR_IMAGE" \
    --offline --persona regular --min-severity medium --min-confidence high /repo/.github/workflows
  endstep

  step "Lockfile de actions (.github/workflows/actions.lock)"
  [ -f .github/workflows/actions.lock ] || fail "falta .github/workflows/actions.lock (gere com: gh actions-lock)"
  if ! gh actions-lock --version >/dev/null 2>&1; then
    fail "extensão gh-actions-lock ausente. Instale: gh extension install github/gh-actions-lock --pin $GH_ACTIONS_LOCK_VERSION"
  fi
  if in_ci; then
    # Verificação completa: confere que cada pin existe e que o runner aceitaria o lockfile.
    gh actions-lock --verify --no-interactive
  else
    gh actions-lock --verify-local
  fi
  endstep
fi

step "Gitleaks"
gitleaks_args=(detect --source /repo --redact --verbose)
if [ -f "$GITLEAKS_CONFIG" ]; then gitleaks_args+=(--config "/repo/$GITLEAKS_CONFIG"); fi
docker run --rm -v "$root:/repo:ro" "$GITLEAKS_IMAGE" "${gitleaks_args[@]}"
endstep

step "Semgrep (p/ci)"
semgrep_args=(semgrep scan --config p/ci --error --metrics=off)
for ex in .claude .codex .worktrees .cache vendor var node_modules build ${SEMGREP_EXCLUDES:-}; do
  semgrep_args+=(--exclude "$ex")
done
docker run --rm -v "$root:/src:ro" -w /src "$SEMGREP_IMAGE" "${semgrep_args[@]}"
endstep

step "OSV (dependências com vulnerabilidade conhecida)"
docker run --rm -v "$root:/src:ro" "$OSV_SCANNER_IMAGE" scan source --recursive /src
endstep

echo "security: verde"
