#!/usr/bin/env bash
# Portão PHP: composer validate e audit, estilo, análise estática, banco de teste e testes.
# Roda onde houver PHP: no runner do CI (setup-php) ou no contêiner da aplicação (make gate).
# Uso: gate/php.sh <arquivo de configuração>   (no diretório do projeto PHP)
source "$(dirname "$0")/lib.sh"
load_config "${1:?uso: php.sh <arquivo de configuração>}"

run() { step "$1"; shift; bash -c "$*"; endstep; }

run "composer validate" composer validate --strict
run "composer install" composer install --prefer-dist --no-progress --no-interaction
run "composer audit" composer audit --locked --format=plain --abandoned=ignore
run "Estilo" "$PHP_CS_CMD"
run "Análise estática" "$PHP_STAN_CMD"
if [ -n "${PHP_DB_PREPARE:-}" ]; then
  run "Banco de teste" "${PHP_TEST_ENV:+env $PHP_TEST_ENV }$PHP_DB_PREPARE"
fi
mkdir -p build/logs
run "Testes" "${PHP_TEST_ENV:+env $PHP_TEST_ENV }$PHP_TEST_CMD"

echo "php: verde"
