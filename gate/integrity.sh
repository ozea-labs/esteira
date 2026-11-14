#!/usr/bin/env bash
# Portão de integridade (OPS-65): o PR não afrouxa o portão que o julga.
# Uso: gate/integrity.sh <base> [head]   (na raiz do repositório consumidor)
#   PR_AUTHOR            login do autor do PR (o Dependabot pode trocar SHA de action e da esteira)
#   PORTAO_LIBERADO_SHA  commit liberado pelo dono (variável do repositório, só administrador grava)
source "$(dirname "$0")/lib.sh"
base="${1:?uso: integrity.sh <base> [head]}"
head="${2:-HEAD}"
cd "$(repo_root)"

step "Integridade do portão"
node "$ESTEIRA_DIR/gate/checks/gate-integrity.mjs" --root . --base "$base" --head "$head" \
  --author "${PR_AUTHOR:-}" --released-sha "${PORTAO_LIBERADO_SHA:-}"
endstep

echo "integrity: verde"
