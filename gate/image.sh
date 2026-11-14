#!/usr/bin/env bash
# Portão de imagem: um build por commit, em arquivo OCI, e tudo o mais sobre esse arquivo.
#   lint   Hadolint no Dockerfile
#   build  constrói o stage IMAGE_TARGET uma vez, em build/esteira-image/image.tar (só na máquina;
#          no CI o build é o docker/build-push-action com cache, com a mesma saída)
#   smoke  carrega o arquivo no Docker e roda o IMAGE_SMOKE do consumidor
#   scan   Trivy (CRITICAL/HIGH com correção bloqueia) e SBOM CycloneDX sobre o mesmo arquivo
#   digest imprime o digest do manifest do arquivo (o que será publicado)
#   all    lint, build, smoke e scan
# Uso: gate/image.sh <arquivo de configuração> <subcomando>   (no diretório do projeto)
source "$(dirname "$0")/lib.sh"
load_config "${1:?uso: image.sh <arquivo de configuração> <subcomando>}"
cmd="${2:?subcomando: lint|build|smoke|scan|digest|all}"
[ -n "${IMAGE_TARGET:-}" ] || fail "IMAGE_TARGET não configurado"

out="${ESTEIRA_IMAGE_OUT:-build/esteira-image}"
archive="$out/image.tar"
candidate="esteira-candidate:local"
mkdir -p "$out"

oci_digest() {
  tar -xOf "$archive" index.json | grep -oE '"digest":"sha256:[0-9a-f]{64}"' | head -1 | cut -d'"' -f4
}

do_lint() {
  step "Hadolint"
  docker run --rm -i "$HADOLINT_IMAGE" hadolint --failure-threshold error - < "$IMAGE_DOCKERFILE"
  endstep
}

do_build() {
  step "Build único do stage $IMAGE_TARGET"
  if ! docker buildx inspect esteira >/dev/null 2>&1; then
    docker buildx create --name esteira --driver docker-container >/dev/null
  fi
  docker buildx build --builder esteira \
    --file "$IMAGE_DOCKERFILE" --target "$IMAGE_TARGET" \
    --provenance=false --sbom=false \
    --output "type=oci,dest=$archive,name=$candidate" \
    "$IMAGE_CONTEXT"
  echo "digest: $(oci_digest)"
  endstep
}

do_smoke() {
  [ -f "$archive" ] || fail "não há $archive; rode o build antes"
  step "Smoke da imagem"
  # O Docker do runner não carrega arquivo OCI; o skopeo converte o MESMO arquivo para docker-archive
  # (mesmas camadas e mesma config, então o mesmo image ID), sem rebuild.
  rm -f "$out/docker.tar"
  docker run --rm -v "$(cd "$out" && pwd):/work" "$SKOPEO_IMAGE" \
    copy --quiet "oci-archive:/work/image.tar" "docker-archive:/work/docker.tar:$candidate"
  docker load -i "$out/docker.tar"
  if [ -n "${IMAGE_SMOKE:-}" ]; then
    bash "$IMAGE_SMOKE" "$candidate"
  else
    echo "IMAGE_SMOKE não configurado: só o carregamento da imagem foi verificado"
  fi
  endstep
}

trivy() {
  docker run --rm -v esteira-trivy-cache:/root/.cache/trivy -v "$(cd "$out" && pwd):/work" "$TRIVY_IMAGE" "$@"
}

do_scan() {
  [ -f "$archive" ] || fail "não há $archive; rode o build antes"
  # O Trivy lê layout OCI em diretório; o diretório sai do mesmo arquivo, sem rebuild.
  rm -rf "$out/oci" && mkdir -p "$out/oci" && tar -xf "$archive" -C "$out/oci"
  step "Trivy (CRITICAL e HIGH com correção bloqueiam)"
  trivy image --no-progress --input /work/oci --scanners vuln --severity CRITICAL,HIGH \
    --ignore-unfixed --pkg-types os,library --format table --exit-code 1
  endstep
  step "SBOM CycloneDX"
  trivy image --no-progress --input /work/oci --format cyclonedx --output /work/sbom.cdx.json
  endstep
}

case "$cmd" in
  lint) do_lint ;;
  build) do_build ;;
  smoke) do_smoke ;;
  scan) do_scan ;;
  digest) oci_digest ;;
  all) do_lint; do_build; do_smoke; do_scan ;;
  *) fail "subcomando desconhecido: $cmd" ;;
esac
