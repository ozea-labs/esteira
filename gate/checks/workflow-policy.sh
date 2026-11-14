#!/usr/bin/env bash
# Política de workflows da esteira. Falha quando um workflow:
#   - usa action ou workflow reutilizável sem SHA de 40 caracteres (ou imagem docker:// sem digest);
#   - tem continue-on-error que não seja false (nenhum check roda só como aviso);
#   - usa pull_request_target;
#   - não declara permissions no topo;
#   - chama a esteira por SHAs diferentes, ou por um SHA diferente de ESTEIRA_SHA quando ela é dada.
# Uso: workflow-policy.sh [diretório de workflows]   (padrão: .github/workflows)
set -euo pipefail
dir="${1:-.github/workflows}"
errors=0
err() { echo "::error file=$1,line=$2::$3"; errors=$((errors + 1)); }

shopt -s nullglob
files=("$dir"/*.yml "$dir"/*.yaml)
[ "${#files[@]}" -gt 0 ] || { echo "workflow-policy: nenhum workflow em $dir"; exit 0; }

esteira_shas=()
for f in "${files[@]}"; do
  grep -qE '^permissions:' "$f" || err "$f" 1 "sem 'permissions:' no topo do workflow"

  while IFS=: read -r n line; do
    ref="$(sed -E 's/^[[:space:]]*-?[[:space:]]*uses:[[:space:]]*//; s/[[:space:]]+#.*$//; s/^["'\'']//; s/["'\'']$//' <<<"$line")"
    case "$ref" in
      ./*|\$/*) continue ;;
      docker://*@sha256:*) [[ "$ref" =~ @sha256:[0-9a-f]{64}$ ]] || err "$f" "$n" "imagem sem digest completo: $ref" ;;
      docker://*) err "$f" "$n" "imagem sem digest: $ref" ;;
      *@*)
        if [[ ! "$ref" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+@[0-9a-f]{40}$ ]]; then
          err "$f" "$n" "uses sem SHA completo: $ref"
        elif [[ "$ref" == ozea-labs/esteira/* ]]; then
          esteira_shas+=("${ref##*@}")
        fi ;;
      *) err "$f" "$n" "uses sem referência: $ref" ;;
    esac
  done < <(grep -nE '^[[:space:]]*-?[[:space:]]*uses:' "$f" || true)

  while IFS=: read -r n line; do
    [[ "$line" =~ continue-on-error:[[:space:]]*false[[:space:]]*(#.*)?$ ]] || err "$f" "$n" "continue-on-error não é permitido (nada roda só como aviso)"
  done < <(grep -nE 'continue-on-error:' "$f" || true)

  while IFS=: read -r n _; do
    err "$f" "$n" "pull_request_target não é permitido"
  done < <(grep -nE '(^|[[:space:],\[])pull_request_target([[:space:]:,\]]|$)' "$f" || true)
done

if [ "${#esteira_shas[@]}" -gt 0 ]; then
  distinct="$(printf '%s\n' "${esteira_shas[@]}" | sort -u)"
  if [ "$(wc -l <<<"$distinct")" -gt 1 ]; then
    err "$dir" 1 "a esteira é chamada por SHAs diferentes: $(tr '\n' ' ' <<<"$distinct")"
  elif [ -n "${ESTEIRA_SHA:-}" ] && [ "$distinct" != "$ESTEIRA_SHA" ]; then
    err "$dir" 1 "o arquivo de chamada fixa a esteira em $distinct, mas o portão rodou com $ESTEIRA_SHA"
  fi
fi

if [ "$errors" -gt 0 ]; then
  echo "workflow-policy: $errors violação(ões)"
  exit 1
fi
echo "workflow-policy: ${#files[@]} workflow(s) conformes"
