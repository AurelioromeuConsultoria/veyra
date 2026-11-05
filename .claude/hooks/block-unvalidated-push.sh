#!/usr/bin/env bash
# Hook PreToolUse (Bash): git push exige confirmação com o checklist de Definition of Done.
# push --force e afins recebem aviso reforçado. Push só acontece se pedido explicitamente (CLAUDE.md §6).
#
# Exceção (ADR-058 adendo 3): o comando INTEIRO exatamente `git push origin main`, na branch
# main, com o origin deste repositório, sai "sem decisão" (`{}`): nem pede nem permite, e as
# aprovações da ferramenta e da plataforma continuam valendo. O hook confere só a forma e o
# destino do push; a autorização do push continua sendo a da conversa (CLAUDE.md §6), que o
# hook não consegue ver. Qualquer outra forma (force, --delete, refspec, outro remote ou
# branch, opções, comando composto), configuração do git que mude o que o push faz e
# qualquer falha da conferência continuam pedindo.
set -uo pipefail

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')

if ! printf '%s' "$cmd" | grep -qE '(^|;|&&|\|\|)[[:space:]]*git[[:space:]]+push\b'; then
  echo '{}'
  exit 0
fi

# o push comum para a main deste repositório: o comando sozinho, sem nada antes nem depois
if [ "$cmd" = 'git push origin main' ]; then
  # o hook roda no diretório do comando (settings.json o chama por caminho relativo); o `cwd`
  # da entrada precisa ser o mesmo, senão a conferência abaixo seria de outro repositório
  dir=$(printf '%s' "$input" | jq -r '.cwd // ""')
  aqui=$(pwd -P)
  if [ -n "$dir" ] && [ "$(cd "$dir" 2>/dev/null && pwd -P)" = "$aqui" ]; then
    branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)
    # --push: a URL de envio de fato, com pushurl e insteadOf/pushInsteadOf aplicados
    urls=$(git remote get-url --push --all origin 2>/dev/null || true)
    # configuração que muda o que este mesmo comando faz: refspec configurada (`+` vira force,
    # outro destino muda a branch), transporte trocado, código no push, envio além da main
    mudam=$(git config --get-regexp '^(remote\.origin\.(push|vcs|receivepack|mirror)|core\.(sshcommand|hookspath)|push\.(followtags|recursesubmodules|pushoption))$' 2>/dev/null || true)
    prepush="$(git rev-parse --git-path hooks 2>/dev/null)/pre-push"
    if [ "$branch" = main ] && [ -n "$urls" ] && [ -z "$mudam" ] && [ ! -e "$prepush" ] &&
      [ -z "${GIT_SSH_COMMAND:-}${GIT_SSH:-}" ] &&
      ! printf '%s\n' "$urls" | grep -qvE '^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)AurelioromeuConsultoria/veyra(\.git)?$'; then
      echo '{}'
      exit 0
    fi
  fi
fi

extra=""
if printf '%s' "$cmd" | grep -qE 'push\b[^|;&]*(--force\b|--force-with-lease\b|[[:space:]]-f\b)'; then
  extra=" ATENÇÃO: push com force reescreve histórico remoto."
fi

reason="Antes do push, confirme o Definition of Done (CLAUDE.md §6): builds passam; testes relevantes verdes (incluindo isolamento P0 se tenancy/RBAC mudou); nenhum segredo staged; migration comitada junto do código; docs/ atualizado; e o usuário pediu este push explicitamente. O push na main publica no staging depois do CI verde (ADR-058), salvo migration, env.ts, Dockerfile ou a pilha de deploy/staging (compose, web, backup), que pedem a janela do DEPLOY_STAGING §4.1.${extra}"

jq -n --arg reason "$reason" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:$reason}}'
exit 0
