#!/usr/bin/env bash
# Smoke do self-test: a imagem roda como não-root e contém o código.
set -euo pipefail
image="${1:?uso: smoke.sh <imagem>}"
[ "$(docker run --rm --entrypoint id "$image" -u)" != "0" ] || { echo "::error::a imagem roda como root"; exit 1; }
docker run --rm "$image" | grep -q 'final class Greeter' || { echo "::error::código ausente na imagem"; exit 1; }
mkdir -p build/smoke && echo "smoke: ok ($image)" > build/smoke/result.txt
echo "smoke: ok"
