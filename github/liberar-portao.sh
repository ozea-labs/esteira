#!/usr/bin/env bash
# Liberação autorizada de um commit que muda caminhos do portão (OPS-65, D3).
# Runbook: docs/runbooks/liberar-portao.md. Rode na raiz do checkout do consumidor.
#
#   liberar-portao.sh --mostrar <owner/repo> <sha>                 só leitura: o que o commit muda no portão
#   liberar-portao.sh <owner/repo> <sha> <branch>                  libera, envia a branch e abre o PR
#   liberar-portao.sh --limpar <owner/repo>                        apaga a variável depois do merge
#   liberar-portao.sh --conferir <owner/repo>                      põe a regra de push em active se não estiver
#
# Precisa do token do dono (administração do repositório). O hook do Claude Code devolve "ask" para
# este script fora do --mostrar: quem autoriza é o dono, no diálogo do cliente, vendo o SHA no comando.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
RULESET=portao-do-agente
VAR=PORTAO_LIBERADO_SHA

say() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERRO:\033[0m %s\n' "$*" >&2; exit 1; }

ruleset_id() { gh api "repos/$1/rulesets" --paginate --jq ".[] | select(.name == \"$RULESET\") | .id" | head -1; }
enforcement() { gh api "repos/$1/rulesets/$2" --jq .enforcement; }
set_enforcement() { gh api --method PUT "repos/$1/rulesets/$2" -f enforcement="$3" --jq .enforcement >/dev/null; }

# A regra nunca fica fora de active: conferida antes de qualquer coisa, no fim, e no trap.
ensure_active() {
  local repo="$1" id="$2" now
  now="$(enforcement "$repo" "$id")"
  if [ "$now" != active ]; then
    echo "AVISO: $RULESET estava em '$now'. Voltando para active." >&2
    set_enforcement "$repo" "$id" active
  fi
  [ "$(enforcement "$repo" "$id")" = active ] || die "$RULESET não voltou para active. Corrija já: gh api --method PUT repos/$repo/rulesets/$id -f enforcement=active"
}

default_branch() { gh api "repos/$1" --jq .default_branch; }

protected_in() {
  local base="$1" sha="$2"
  node "$here/../gate/checks/gate-integrity.mjs" --root . --base "$base" --head "$sha" --list-protected
}

mostrar() {
  local repo="$1" sha="$2" main base
  main="$(default_branch "$repo")"
  git fetch -q origin "$main"
  git cat-file -e "$sha^{commit}" 2>/dev/null || die "commit $sha não existe neste checkout"
  sha="$(git rev-parse "$sha")"
  base="origin/$main"
  say "Commit $sha sobre $base"
  git log --format='  %h %s (%an)' "$(git merge-base "$base" "$sha")..$sha"
  local files; files="$(protected_in "$base" "$sha")"
  [ -n "$files" ] || die "o commit não toca caminho do portão: não precisa de liberação"
  say "Caminhos do portão que mudam"
  sed 's/^/  /' <<<"$files"
  say "Diff desses caminhos"
  # shellcheck disable=SC2086
  git --no-pager diff --stat "$(git merge-base "$base" "$sha")" "$sha"
  mapfile -t list <<<"$files"
  git --no-pager diff "$(git merge-base "$base" "$sha")" "$sha" -- "${list[@]}"
}

case "${1:-}" in
  --mostrar)
    mostrar "${2:?uso: --mostrar <owner/repo> <sha>}" "${3:?uso: --mostrar <owner/repo> <sha>}"
    exit 0 ;;
  --limpar)
    repo="${2:?uso: --limpar <owner/repo>}"
    gh api --method DELETE "repos/$repo/actions/variables/$VAR" 2>/dev/null && echo "$VAR apagada" || echo "$VAR já não existia"
    id="$(ruleset_id "$repo")"; [ -n "$id" ] && ensure_active "$repo" "$id"
    exit 0 ;;
  --conferir)
    repo="${2:?uso: --conferir <owner/repo>}"
    id="$(ruleset_id "$repo")"; [ -n "$id" ] || die "ruleset $RULESET não existe em $repo"
    ensure_active "$repo" "$id"; echo "$RULESET: active"
    exit 0 ;;
esac

repo="${1:?uso: liberar-portao.sh <owner/repo> <sha> <branch>}"
sha_arg="${2:?uso: liberar-portao.sh <owner/repo> <sha> <branch>}"
branch="${3:?uso: liberar-portao.sh <owner/repo> <sha> <branch>}"
[[ "$sha_arg" =~ ^[0-9a-f]{40}$ ]] || die "passe o SHA completo de 40 caracteres (é o que o dono autoriza)"
[[ "$branch" != "main" && "$branch" != "master" ]] || die "a branch precisa ser de PR, não a padrão"

id="$(ruleset_id "$repo")"
[ -n "$id" ] || die "ruleset $RULESET não existe em $repo: aplique com github/apply-rulesets.sh"
ensure_active "$repo" "$id"

mostrar "$repo" "$sha_arg"
sha="$sha_arg"

say "1/4 Variável $VAR=$sha"
if gh api "repos/$repo/actions/variables/$VAR" >/dev/null 2>&1; then
  gh api --method PATCH "repos/$repo/actions/variables/$VAR" -f name="$VAR" -f value="$sha" >/dev/null
else
  gh api --method POST "repos/$repo/actions/variables" -f name="$VAR" -f value="$sha" >/dev/null
fi

say "2/4 Regra de push em evaluate só durante o push"
trap 'ensure_active "$repo" "$id"' EXIT INT TERM
set_enforcement "$repo" "$id" evaluate
push_ok=true
git push origin "$sha:refs/heads/$branch" || push_ok=false
set_enforcement "$repo" "$id" active
ensure_active "$repo" "$id"
trap - EXIT INT TERM
$push_ok || die "o push falhou; a regra já voltou para active e a variável continua com $sha"
echo "  $RULESET: active de novo"

say "3/4 PR"
main="$(default_branch "$repo")"
if gh pr view "$branch" --repo "$repo" --json url --jq .url 2>/dev/null; then
  echo "  PR já existia"
else
  gh pr create --repo "$repo" --base "$main" --head "$branch" \
    --title "$(git log -1 --format=%s "$sha")" \
    --body "$(git log -1 --format=%b "$sha")

---
Commit \`$sha\` liberado pelo dono (\`$VAR\`, OPS-65). O check \`integrity\` aceita só este SHA; um commit novo no PR precisa de nova liberação."
fi

say "4/4 Depois do merge: github/liberar-portao.sh --limpar $repo"
