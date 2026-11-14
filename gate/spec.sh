#!/usr/bin/env bash
# Portão de spec (OPS-67): OpenSpec fixado, skills sem edição manual, validate --strict,
# lint da Ozea e, quando o PR entrega uma change, integridade e conformidade.
# Uso: gate/spec.sh <arquivo de configuração> [base]   (na raiz do repositório consumidor)
#   base: SHA base do PR. Sem base (push na main ou máquina local sem PR), compara com HEAD:
#   só validate e lint se aplicam, porque o PR já provou integridade e conformidade.
source "$(dirname "$0")/lib.sh"
load_config "${1:?uso: spec.sh <arquivo de configuração> [base]}"
base="${2:-HEAD}"
openspec="$ESTEIRA_DIR/gate/spec/bin/openspec"
export OPENSPEC_TELEMETRY=0
# Variáveis de teste do consumidor (ex.: APP_ENV=test) valem para o banco e para o PHPUnit da conformidade.
# shellcheck disable=SC2086
if [ -n "${PHP_TEST_ENV:-}" ]; then export $PHP_TEST_ENV; fi

step "composer install"
composer install --prefer-dist --no-progress --no-interaction
endstep

step "OpenSpec fixado"
if [ ! -x "$ESTEIRA_DIR/gate/spec/openspec/node_modules/.bin/openspec" ]; then
  npm ci --ignore-scripts --no-audit --no-fund --prefix "$ESTEIRA_DIR/gate/spec/openspec"
fi
"$openspec" --version
endstep

step "Skills do OpenSpec são a saída sem edição da versão fixada"
"$openspec" update
git diff --exit-code -- .agents .claude openspec
test -z "$(git status --porcelain -- .agents .claude openspec)" || fail "openspec update criou arquivos não versionados"
endstep

if [ -n "${PHP_DB_PREPARE:-}" ]; then
  step "Banco de teste"
  bash -c "$PHP_DB_PREPARE"
  endstep
fi

step "Validate, lint, integridade e conformidade"
node "$ESTEIRA_DIR/gate/spec/check.mjs" --root . --base "$base" --head HEAD \
  --openspec "$openspec" \
  --phpunit "$SPEC_PHPUNIT_CMD" \
  --prepare "$SPEC_PREPARE_CMD"
endstep

echo "spec: verde"
