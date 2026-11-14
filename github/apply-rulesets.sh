#!/usr/bin/env bash
# Aplica os rulesets versionados em github/rulesets/<repositório>/ (OPS-65, D1). Idempotente.
#
# Uso: github/apply-rulesets.sh <owner/repo> [--dry-run] [--enforcement evaluate|active]
#   --dry-run       só mostra o que mudaria
#   --enforcement   sobrepõe o enforcement de todos os rulesets (rodada em evaluate antes de ativar)
#
# Precisa do token do dono (administração do repositório). Nenhum app de agente tem essa permissão.
# O hook do Claude Code devolve "ask" para este script: o dono confirma no diálogo do cliente.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="${1:?uso: apply-rulesets.sh <owner/repo> [--dry-run] [--enforcement evaluate|active]}"; shift
dry=false; enforcement=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=true ;;
    --enforcement) enforcement="${2:?falta valor}"; shift ;;
    *) echo "argumento desconhecido: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ -z "$enforcement" || "$enforcement" =~ ^(evaluate|active)$ ]] || { echo "enforcement inválido: $enforcement" >&2; exit 2; }

dir="$here/rulesets/${repo#*/}"
[ -d "$dir" ] || { echo "sem rulesets versionados para $repo em $dir" >&2; exit 2; }
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

changed=0
for file in "$dir"/*.json; do
  node "$here/rulesets.mjs" render "$file" "$here/../gate/protected-paths.txt" "$enforcement" > "$tmp/desired.json"
  name="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).name)' "$tmp/desired.json")"
  id="$(gh api "repos/$repo/rulesets" --paginate --jq ".[] | select(.name == \"$name\") | .id" | head -1)"

  if [ -z "$id" ]; then
    echo "$name: novo"
    changed=$((changed + 1))
    $dry || gh api --method POST "repos/$repo/rulesets" --input "$tmp/desired.json" --jq '"  criado: id \(.id), \(.enforcement)"'
    continue
  fi

  gh api "repos/$repo/rulesets/$id" > "$tmp/current.json"
  if node "$here/rulesets.mjs" same "$tmp/desired.json" "$tmp/current.json"; then
    echo "$name: sem mudança"
    continue
  fi
  echo "$name: muda"
  node "$here/rulesets.mjs" diff "$tmp/desired.json" "$tmp/current.json" || true
  changed=$((changed + 1))
  $dry || gh api --method PUT "repos/$repo/rulesets/$id" --input "$tmp/desired.json" --jq '"  atualizado: id \(.id), \(.enforcement)"'
done

if $dry; then echo "dry-run: $changed ruleset(s) mudariam"; else echo "aplicado: $changed ruleset(s) mudaram"; fi
