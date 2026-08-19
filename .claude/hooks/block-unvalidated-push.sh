#!/usr/bin/env bash
# Hook PreToolUse (Bash): git push exige confirmação com o checklist de Definition of Done.
# push --force e afins recebem aviso reforçado. Push só acontece se pedido explicitamente (CLAUDE.md §6).
set -uo pipefail

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')

if ! printf '%s' "$cmd" | grep -qE '(^|;|&&|\|\|)[[:space:]]*git[[:space:]]+push\b'; then
  echo '{}'
  exit 0
fi

extra=""
if printf '%s' "$cmd" | grep -qE 'push\b[^|;&]*(--force\b|--force-with-lease\b|[[:space:]]-f\b)'; then
  extra=" ATENÇÃO: push com force reescreve histórico remoto."
fi

reason="Antes do push, confirme o Definition of Done (CLAUDE.md §6): builds passam; testes relevantes verdes (incluindo isolamento P0 se tenancy/RBAC mudou); nenhum segredo staged; migration comitada junto do código; docs/ atualizado; e o usuário pediu este push explicitamente.${extra}"

jq -n --arg reason "$reason" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:$reason}}'
exit 0
