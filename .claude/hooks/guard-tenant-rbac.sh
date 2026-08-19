#!/usr/bin/env bash
# Hook PreToolUse (Bash | Edit | Write): protege os arquivos que sustentam isolamento de tenant e RBAC.
# - Edit/Write em arquivo sensível => additionalContext lembrando as invariantes + revisão obrigatória.
# - git commit com arquivo sensível no stage => ask exigindo revisão de security + reviewer.
# Arquivos sensíveis: prisma.service, guards, decorators de permissão, WORKSPACE_MODELS, auth.
set -uo pipefail

input=$(cat)
tool=$(printf '%s' "$input" | jq -r '.tool_name // ""')
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""')

SENSITIVE_RE='(prisma\.service\.(ts|js)|workspace-models|jwt-auth\.guard|permissions\.guard|auth\.service|decorators\.(ts|js)|\.claude/hooks/)'

context() {
  jq -n --arg msg "$1" '{systemMessage:$msg,hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$msg}}'
  exit 0
}
ask() {
  jq -n --arg reason "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:$reason}}'
  exit 0
}

# Edição direta de arquivo sensível
if { [ "$tool" = "Edit" ] || [ "$tool" = "Write" ]; } && printf '%s' "$file" | grep -qiE "$SENSITIVE_RE"; then
  context "ATENÇÃO: '$file' sustenta isolamento de tenant/RBAC. Invariantes (docs/SECURITY.md §2/§4): fail-closed sem workspace no CLS; operações unsafe bloqueadas; raw só nas exceções documentadas; permissões por chave, nunca por nome de role; tokenVersion respeitado. Antes do commit, esta mudança EXIGE revisão dos agentes security e reviewer."
fi

# Commit com arquivo sensível no stage
if [ "$tool" = "Bash" ] && printf '%s' "$cmd" | grep -qE '(^|;|&&|\|\|)[[:space:]]*git[[:space:]]+commit\b'; then
  staged=$(git diff --cached --name-only 2>/dev/null | grep -iE "$SENSITIVE_RE" || true)
  if [ -n "$staged" ]; then
    ask "Commit toca arquivo(s) sensíveis de tenancy/RBAC: ${staged//$'\n'/, }. Os agentes security (read-only) e reviewer já revisaram este diff e aprovaram? O teste P0 de isolamento passa? (CLAUDE.md §5.4, docs/SECURITY.md §10)"
  fi
fi

echo '{}'
exit 0
