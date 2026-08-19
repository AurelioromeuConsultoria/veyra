#!/usr/bin/env bash
# Hook PreToolUse (Bash): bloqueia/pergunta em migrations destrutivas.
# Filtra DENTRO do script (o matcher do settings.json não é confiável — aprendizado do Norteie).
# deny: TRUNCATE ou DROP TABLE dentro de arquivo de migration sendo criado/aplicado.
# ask:  DROP COLUMN, NOT NULL sem default, prisma migrate reset/db push --force-reset.
set -uo pipefail

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')

if [ -z "$cmd" ]; then
  echo '{}'
  exit 0
fi

deny() {
  jq -n --arg reason "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
  exit 0
}
ask() {
  jq -n --arg reason "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:$reason}}'
  exit 0
}

# Reset destrutivo de banco via CLI
if printf '%s' "$cmd" | grep -qiE 'prisma[[:space:]]+(migrate[[:space:]]+reset|db[[:space:]]+push[^|;&]*--force-reset)'; then
  ask "Comando de reset destrutivo de banco detectado (prisma migrate reset / db push --force-reset). Confirme que é ambiente de desenvolvimento descartável. Ver docs/SECURITY.md e CLAUDE.md §4."
fi

# SQL destrutivo digitado direto num comando que menciona migrations
if printf '%s' "$cmd" | grep -qiE 'migrations?' ; then
  if printf '%s' "$cmd" | grep -qiE '\b(TRUNCATE([[:space:]]+TABLE)?|DROP[[:space:]]+TABLE)\b'; then
    deny "TRUNCATE/DROP TABLE em contexto de migration é bloqueado. Migration destrutiva exige plano aprovado (backup, migração de dados) — ver CLAUDE.md §4 e docs/SECURITY.md. Escreva a migration com o plano e peça revisão de security."
  fi
  if printf '%s' "$cmd" | grep -qiE '\bDROP[[:space:]]+COLUMN\b'; then
    ask "DROP COLUMN em migration detectado. Há plano de migração de dados e a coluna não é mais lida por nenhum código em produção? Ver CLAUDE.md §4."
  fi
  if printf '%s' "$cmd" | grep -qiE 'SET[[:space:]]+NOT[[:space:]]+NULL|ADD[[:space:]]+COLUMN[^|;&]*NOT[[:space:]]+NULL' && ! printf '%s' "$cmd" | grep -qiE 'DEFAULT'; then
    ask "NOT NULL sem DEFAULT em migration: falha se a tabela tiver linhas. Adicione DEFAULT ou faça em duas etapas (backfill + constraint)."
  fi
fi

echo '{}'
exit 0
