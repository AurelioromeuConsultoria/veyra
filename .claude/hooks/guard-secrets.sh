#!/usr/bin/env bash
# Hook PreToolUse (Bash): NEGA commit contendo segredos.
# .env staged (exceto .env.example), chaves privadas e tokens/api keys reais => deny (não ask).
# Ver docs/SECURITY.md §8 e CLAUDE.md §3.12.
set -uo pipefail

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')

# Só age em git commit (filtro dentro do script; matcher não é confiável)
if ! printf '%s' "$cmd" | grep -qE '(^|;|&&|\|\|)[[:space:]]*git[[:space:]]+commit\b'; then
  echo '{}'
  exit 0
fi

deny() {
  jq -n --arg reason "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
  exit 0
}

# 1) Arquivos .env staged (permitido apenas .env.example / *.env.example)
env_files=$(git diff --cached --name-only 2>/dev/null | grep -E '(^|/)\.env(\.[A-Za-z0-9_-]+)?$' | grep -vE '\.env\.example$' || true)
if [ -n "$env_files" ]; then
  deny "Commit bloqueado: arquivo(s) .env no stage: ${env_files//$'\n'/, }. Apenas .env.example com placeholders é permitido. Remova com 'git restore --staged <arquivo>'. Ver docs/SECURITY.md §8."
fi

# 2) Conteúdo staged: chaves privadas e tokens/api keys com aparência real
secret_hits=$(git diff --cached 2>/dev/null | grep -nEi -- '-----BEGIN [A-Z ]*PRIVATE KEY|api[_-]?(key|secret)[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9_\-]{12,}|(sk|pk)[-_](live|test|ant|proj)[-_][A-Za-z0-9_\-]{8,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|xox[bpars]-[A-Za-z0-9-]{10,}' | head -5 || true)
if [ -n "$secret_hits" ]; then
  deny "Commit bloqueado: conteúdo com aparência de segredo real no stage (chave privada/API key/token). Trechos: $(printf '%s' "$secret_hits" | tr '\n' ' ' | cut -c1-300). Use placeholders em .env.example e variáveis de ambiente. Ver docs/SECURITY.md §8."
fi

echo '{}'
exit 0
