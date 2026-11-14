#!/usr/bin/env bash
# Lê a configuração do consumidor e escreve as saídas do job `config` no GITHUB_OUTPUT.
# Uso: gate/config.sh <arquivo de configuração>
source "$(dirname "$0")/lib.sh"
load_config "${1:?uso: config.sh <arquivo>}"
[ -n "${PHP_VERSION:-}" ] || fail "PHP_VERSION é obrigatório"
[[ "${PHP_COVERAGE}" =~ ^(pcov|xdebug|none)$ ]] || fail "PHP_COVERAGE inválido: $PHP_COVERAGE"
[[ "${SPEC_ENABLED}" =~ ^(true|false)$ ]] || fail "SPEC_ENABLED deve ser true ou false"
if [ -n "${POSTGRES_VERSION:-}" ]; then
  [[ "$POSTGRES_VERSION" =~ ^[0-9]+$ ]] || fail "POSTGRES_VERSION deve ser só o major (ex.: 16)"
  postgres_image="postgres:${POSTGRES_VERSION}-alpine"
else
  postgres_image=""
fi
postgres_version="${POSTGRES_VERSION:-16}"
if [ -n "${IMAGE_NAME:-}" ]; then
  [[ "$IMAGE_NAME" =~ ^ghcr\.io/[a-z0-9._/-]+$ ]] || fail "IMAGE_NAME deve ser ghcr.io/<org>/<nome>"
  [ -n "${IMAGE_TARGET:-}" ] || fail "IMAGE_TARGET é obrigatório quando IMAGE_NAME existe"
fi
# A imagem é construída e escaneada quando há IMAGE_TARGET; IMAGE_NAME só é exigido para publicar.
if [ -n "${IMAGE_TARGET:-}" ]; then has_image=true; else has_image=false; fi
out="${GITHUB_OUTPUT:-/dev/stdout}"
{
  echo "php-version=$PHP_VERSION"
  echo "php-extensions=${PHP_EXTENSIONS:-}"
  echo "php-coverage=$PHP_COVERAGE"
  echo "postgres-image=$postgres_image"
  echo "postgres-version=$postgres_version"
  echo "spec-enabled=$SPEC_ENABLED"
  echo "has-image=$has_image"
  echo "image-name=${IMAGE_NAME:-}"
} >> "$out"
