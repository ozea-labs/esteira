#!/usr/bin/env bash
# Publica no GHCR o MESMO arquivo OCI que o portão escaneou, sem rebuild, e confere o digest.
# Uso: gate/publish.sh <arquivo image.tar> <imagem ghcr.io/org/nome> <digest esperado> <sha do commit>
# Credenciais: REGISTRY_USER e REGISTRY_PASSWORD no ambiente.
source "$(dirname "$0")/lib.sh"
archive="${1:?arquivo}"; image="${2:?imagem}"; expected="${3:?digest}"; sha="${4:?sha}"
: "${REGISTRY_USER:?}" "${REGISTRY_PASSWORD:?}"
[[ "$expected" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "digest esperado inválido: $expected"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail "sha inválido: $sha"
[[ "$image" =~ ^ghcr\.io/[a-z0-9._/-]+$ ]] || fail "imagem inválida: $image"

actual_archive="$(tar -xOf "$archive" index.json | grep -oE '"digest":"sha256:[0-9a-f]{64}"' | head -1 | cut -d'"' -f4)"
[ "$actual_archive" = "$expected" ] || fail "o arquivo tem $actual_archive, mas o portão escaneou $expected"

dir="$(cd "$(dirname "$archive")" && pwd)"; file="$(basename "$archive")"
skopeo() {
  docker run --rm -e REGISTRY_USER -e REGISTRY_PASSWORD -v "$dir:/work:ro" --entrypoint sh "$SKOPEO_IMAGE" -c "$1"
}

for tag in "sha-$sha" "sha-${sha:0:7}" main; do
  step "Publica $image:$tag"
  skopeo "skopeo copy --preserve-digests --dest-creds \"\$REGISTRY_USER:\$REGISTRY_PASSWORD\" oci-archive:/work/$file docker://$image:$tag"
  endstep
done

step "Confere o digest publicado"
published="$(skopeo "skopeo inspect --creds \"\$REGISTRY_USER:\$REGISTRY_PASSWORD\" --format '{{.Digest}}' docker://$image:sha-$sha")"
[ "$published" = "$expected" ] || fail "publicado $published, escaneado $expected"
endstep

echo "publicado: $image@$expected (sha-$sha, sha-${sha:0:7}, main)"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Imagem publicada"
    echo ""
    echo "\`$image@$expected\`"
    echo ""
    echo "Tags: \`sha-$sha\`, \`sha-${sha:0:7}\`, \`main\`. O digest é o mesmo que o Trivy escaneou neste run."
  } >> "$GITHUB_STEP_SUMMARY"
fi
