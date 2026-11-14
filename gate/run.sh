#!/usr/bin/env bash
# make gate: os mesmos scripts do CI, na máquina, com as mesmas imagens fixadas por digest.
# Uso: gate/run.sh <arquivo de configuração> [security] [php] [spec] [image]   (padrão: todos os aplicáveis)
# ESTEIRA_PHP_RUNNER: prefixo que roda um comando no contêiner PHP do consumidor
#   (ex.: "docker compose run --rm -T app"). Vazio roda com o PHP do host.
source "$(dirname "$0")/lib.sh"
config="${1:?uso: run.sh <arquivo de configuração> [etapas...]}"; shift
load_config "$config"
stages=("$@")
if [ "${#stages[@]}" -eq 0 ]; then
  stages=(security integrity php)
  [ "$SPEC_ENABLED" = "true" ] && stages+=(spec)
  [ -n "${IMAGE_TARGET:-}" ] && stages+=(image)
fi

root="$(repo_root)"
rel_esteira="$(realpath --relative-to="$PWD" "$ESTEIRA_DIR")"
rel_config="$(realpath --relative-to="$PWD" "$config")"
runner="${ESTEIRA_PHP_RUNNER:-}"

# O SHA que o make gate usa é o do arquivo de chamada; a política confere a mesma coisa no CI.
ESTEIRA_SHA="$(basename "$ESTEIRA_DIR")"
[[ "$ESTEIRA_SHA" =~ ^[0-9a-f]{40}$ ]] && export ESTEIRA_SHA || unset ESTEIRA_SHA

for stage in "${stages[@]}"; do
  case "$stage" in
    security) (cd "$root" && bash "$ESTEIRA_DIR/gate/security.sh" "$(realpath "$config")") ;;
    integrity) $runner bash "$rel_esteira/gate/integrity.sh" "$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD)" HEAD ;;
    php)      $runner bash "$rel_esteira/gate/php.sh" "$rel_config" ;;
    spec)     $runner bash "$rel_esteira/gate/spec.sh" "$rel_config" "$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD)" ;;
    image)    bash "$ESTEIRA_DIR/gate/image.sh" "$config" all ;;
    *) fail "etapa desconhecida: $stage" ;;
  esac
done
echo "make gate: verde (${stages[*]})"
