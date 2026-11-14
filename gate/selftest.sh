#!/usr/bin/env bash
# PRs envenenados da própria esteira: cada caso precisa ser REPROVADO pelo portão.
# Uso: gate/selftest.sh   (na raiz do repositório da esteira)
source "$(dirname "$0")/lib.sh"
cd "$ESTEIRA_DIR"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
passed=0; failed=0

# expect_fail <nome> <padrão esperado na saída> <comando...>
# O padrão garante que a reprovação veio do achado, e não de um erro qualquer da ferramenta.
expect_fail() {
  local name="$1" pattern="$2"; shift 2
  if ( set -e; "$@" ) >"$tmp/out.log" 2>&1; then
    echo "::error::o portão aceitou o caso envenenado: $name"; tail -20 "$tmp/out.log"; failed=$((failed + 1))
  elif ! grep -qE "$pattern" "$tmp/out.log"; then
    echo "::error::$name reprovou, mas sem o achado esperado (/$pattern/)"; tail -20 "$tmp/out.log"; failed=$((failed + 1))
  else
    echo "reprovado como esperado: $name"; passed=$((passed + 1))
  fi
}

expect_pass() {
  local name="$1"; shift
  if ( set -e; "$@" ) >"$tmp/out.log" 2>&1; then
    echo "aprovado como esperado: $name"; passed=$((passed + 1))
  else
    echo "::error::o portão reprovou o caso válido: $name"; tail -20 "$tmp/out.log"; failed=$((failed + 1))
  fi
}

one_workflow() { mkdir -p "$tmp/wf/$1" && cp "$2" "$tmp/wf/$1/" && bash gate/checks/workflow-policy.sh "$tmp/wf/$1"; }

step "Política de workflows"
declare -A why=(
  [tag-pin]="uses sem SHA completo"
  [continue-on-error]="continue-on-error não é permitido"
  [pull-request-target]="pull_request_target não é permitido"
  [no-permissions]="sem 'permissions:'"
  [esteira-mixed]="SHAs diferentes"
)
for f in fixtures/bad/workflows/*.yml; do
  n="$(basename "$f" .yml)"
  expect_fail "workflow $n" "${why[$n]:?caso sem motivo esperado: $n}" one_workflow "$n" "$f"
done
mkdir -p "$tmp/wf/pinned"
sed '/^  b:/,$d' fixtures/bad/workflows/esteira-mixed.yml > "$tmp/wf/pinned/caller.yml"
expect_fail "esteira fixada em SHA diferente de ESTEIRA_SHA" "mas o portão rodou com" env ESTEIRA_SHA=3333333333333333333333333333333333333333 \
  bash gate/checks/workflow-policy.sh "$tmp/wf/pinned"
expect_pass "esteira fixada no mesmo SHA de ESTEIRA_SHA" env ESTEIRA_SHA=1111111111111111111111111111111111111111 \
  bash gate/checks/workflow-policy.sh "$tmp/wf/pinned"
expect_pass "workflows da própria esteira" bash gate/checks/workflow-policy.sh .github/workflows
endstep

step "zizmor"
expect_fail "injeção de template" "template-injection" docker run --rm -v "$ESTEIRA_DIR/fixtures/bad/zizmor:/w:ro" "$ZIZMOR_IMAGE" \
  --offline --persona regular --min-severity medium --min-confidence high /w/template-injection.yml
endstep

step "Configuração do consumidor não executa código"
printf 'PHP_VERSION=8.4\nPHP_CS_CMD=$(touch %s/pwned)\n' "$tmp" > "$tmp/ok-but-literal.env"
check_literal() { load_config "$tmp/ok-but-literal.env"; [ ! -e "$tmp/pwned" ] && [ "$PHP_CS_CMD" = "\$(touch $tmp/pwned)" ]; }
expect_pass "valor com \$(...) fica literal" check_literal
printf 'PHP_VERSION=8.4\nLD_PRELOAD=/tmp/x.so\n' > "$tmp/unknown.env"
expect_fail "chave fora da lista" "chave desconhecida LD_PRELOAD" load_config "$tmp/unknown.env"
printf 'PHP_VERSION=8.4\n$(touch %s/pwned2)\n' "$tmp" > "$tmp/garbage.env"
expect_fail "linha que não é CHAVE=valor" "linha inválida" load_config "$tmp/garbage.env"
[ ! -e "$tmp/pwned2" ] || { echo "::error::a configuração executou código"; failed=$((failed + 1)); }
endstep

step "Segredo versionado e artefato de agente"
git init -q "$tmp/leak" && (
  git config core.autocrlf false
  cd "$tmp/leak"
  git config user.email t@example.invalid && git config user.name t
  printf 'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYzEXAMPLEKEYx"\naws_access_key_id = "AKIAQWERTYUIOPASDFGH"\n' > creds.ini
  git add creds.ini && git commit -qm leak
)
expect_fail "segredo no histórico (Gitleaks)" "leaks found" docker run --rm -v "$tmp/leak:/repo:ro" "$GITLEAKS_IMAGE" detect --source /repo --redact
git init -q "$tmp/artifact" && (
  cd "$tmp/artifact"
  git config user.email t@example.invalid && git config user.name t
  mkdir -p node_modules/x && echo x > node_modules/x/i.js && git add -f node_modules && git commit -qm art
)
expect_fail "node_modules versionado" "node_modules/x/i.js" bash -c "cd '$tmp/artifact' && bash '$ESTEIRA_DIR/gate/checks/agent-artifact-guard.sh'"
endstep

step "Imagem com CVE alta corrigida"
vuln_scan() {
  cd fixtures/vuln-image
  ESTEIRA_IMAGE_OUT="$tmp/vuln" bash "$ESTEIRA_DIR/gate/image.sh" esteira.env build
  ESTEIRA_IMAGE_OUT="$tmp/vuln" bash "$ESTEIRA_DIR/gate/image.sh" esteira.env scan
}
expect_fail "Trivy na alpine 3.10" "(HIGH|CRITICAL): [1-9]" vuln_scan
endstep

step "Publicação recusa digest diferente do escaneado"
mkdir -p "$tmp/pub" && printf '{"manifests":[{"digest":"sha256:%064d"}]}' 1 > "$tmp/pub/index.json"
tar -cf "$tmp/pub/image.tar" -C "$tmp/pub" index.json
expect_fail "digest trocado" "mas o portão escaneou" env REGISTRY_USER=x REGISTRY_PASSWORD=x \
  bash gate/publish.sh "$tmp/pub/image.tar" ghcr.io/ozea-labs/x "sha256:$(printf '%064d' 2)" "$(printf '%040d' 0)"
endstep

echo "selftest: $passed caso(s) conforme o esperado, $failed fora do esperado"
[ "$failed" -eq 0 ]
