#!/usr/bin/env bash
# Funções comuns dos scripts do portão. Uso: source "$(dirname "$0")/lib.sh"
set -euo pipefail

ESTEIRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ESTEIRA_DIR

# shellcheck source=versions.env
set -a; . "$ESTEIRA_DIR/gate/versions.env"; set +a

in_ci() { [ "${GITHUB_ACTIONS:-}" = "true" ]; }

step() {
  if in_ci; then echo "::group::$*"; else printf '\n\033[1;36m==> %s\033[0m\n' "$*"; fi
}
endstep() { if in_ci; then echo "::endgroup::"; fi; }

fail() {
  if in_ci; then echo "::error::$*"; else printf '\033[1;31mERRO:\033[0m %s\n' "$*" >&2; fi
  return 1
}

# Chaves aceitas no arquivo de configuração do consumidor (.github/esteira.env).
ESTEIRA_KEYS=(
  PHP_VERSION PHP_EXTENSIONS PHP_COVERAGE POSTGRES_VERSION
  PHP_CS_CMD PHP_STAN_CMD PHP_TEST_CMD PHP_DB_PREPARE PHP_TEST_ENV
  SPEC_ENABLED SPEC_PHPUNIT_CMD SPEC_PREPARE_CMD
  IMAGE_NAME IMAGE_DOCKERFILE IMAGE_CONTEXT IMAGE_TARGET IMAGE_SMOKE
  GITLEAKS_CONFIG SEMGREP_EXCLUDES
)

# load_config <arquivo>: lê KEY=VALUE sem executar nada (sem source/eval) e exporta.
# Linhas vazias e começadas por # são ignoradas. Aspas externas simples ou duplas são removidas.
load_config() {
  local file="$1" line key value n=0
  [ -f "$file" ] || { fail "arquivo de configuração não encontrado: $file"; return 1; }
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    if [[ ! "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]]; then
      fail "$file:$n: linha inválida (esperado CHAVE=valor)"; return 1
    fi
    key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
    if [[ ! " ${ESTEIRA_KEYS[*]} " == *" $key "* ]]; then
      fail "$file:$n: chave desconhecida $key"; return 1
    fi
    if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then value="${BASH_REMATCH[1]}"; fi
    export "$key=$value"
  done < "$file"

  : "${PHP_COVERAGE:=pcov}"
  : "${PHP_CS_CMD:=vendor/bin/php-cs-fixer fix --dry-run --diff}"
  : "${PHP_STAN_CMD:=vendor/bin/phpstan analyse --no-progress --memory-limit=1G}"
  if [ "$PHP_COVERAGE" = "none" ]; then
    : "${PHP_TEST_CMD:=vendor/bin/phpunit}"
  else
    # Sem driver de cobertura o PHPUnit falha: a máquina precisa do mesmo pcov/xdebug do CI.
    : "${PHP_TEST_CMD:=vendor/bin/phpunit --coverage-clover build/logs/clover.xml}"
  fi
  : "${SPEC_ENABLED:=false}"
  : "${SPEC_PHPUNIT_CMD:=php vendor/bin/phpunit}"
  : "${SPEC_PREPARE_CMD:=composer install --prefer-dist --no-progress --no-interaction --no-scripts --quiet}"
  : "${IMAGE_DOCKERFILE:=Dockerfile}"
  : "${IMAGE_CONTEXT:=.}"
  : "${GITLEAKS_CONFIG:=.gitleaks.toml}"
  export PHP_COVERAGE PHP_CS_CMD PHP_STAN_CMD PHP_TEST_CMD SPEC_ENABLED SPEC_PHPUNIT_CMD SPEC_PREPARE_CMD \
    IMAGE_DOCKERFILE IMAGE_CONTEXT GITLEAKS_CONFIG
}

# Raiz do repositório consumidor (o diretório git onde o portão roda).
repo_root() { git rev-parse --show-toplevel; }
