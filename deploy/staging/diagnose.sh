#!/usr/bin/env bash
# DIAGNÓSTICO SOMENTE LEITURA da VPS. Nenhum comando aqui cria, altera,
# reinicia ou remove coisa alguma — é seguro rodar numa máquina que hospeda
# VerboPlus, Norteie e outros projetos em produção.
#
#   scp deploy/staging/diagnose.sh usuario@77.37.43.5:/tmp/
#   ssh usuario@77.37.43.5 'bash /tmp/diagnose.sh' > diagnostico.txt
#
# A saída não contém senha nem variável de ambiente de container: só nomes,
# portas, redes e volumes. Confira antes de compartilhar mesmo assim.
set -u

secao() { printf '\n\n═══ %s ═══\n' "$1"; }
tem()   { command -v "$1" >/dev/null 2>&1; }

secao 'HOST'
uname -a
[ -r /etc/os-release ] && . /etc/os-release && echo "distro: ${PRETTY_NAME:-?}"
echo "uptime:$(uptime)"
echo; echo '— memória —'; free -h 2>/dev/null || true
echo; echo '— disco —';  df -hT 2>/dev/null | grep -vE 'tmpfs|udev' || true

secao 'PORTAS EM ESCUTA (quem ocupa 80/443 e o que mais está exposto)'
if tem ss; then ss -ltnp 2>/dev/null || ss -ltn; else netstat -ltnp 2>/dev/null; fi

secao 'DOCKER — versão e uso de espaço'
tem docker || { echo 'docker ausente'; exit 0; }
docker version --format 'client {{.Client.Version}} / server {{.Server.Version}}' 2>/dev/null
docker compose version 2>/dev/null
echo; docker system df 2>/dev/null

secao 'CONTAINERS (todos, inclusive parados)'
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null

secao 'PROJETOS COMPOSE'
docker ps -a --format '{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null | sort -u

secao 'REDES (nome do proxy sai daqui)'
docker network ls 2>/dev/null
echo; echo '— sub-redes em uso (colisão de faixa é a falha silenciosa clássica) —'
for rede in $(docker network ls --format '{{.Name}}' 2>/dev/null); do
  faixa=$(docker network inspect "$rede" --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null)
  anexos=$(docker network inspect "$rede" --format '{{len .Containers}}' 2>/dev/null)
  printf '%-32s %-20s %s container(s)\n' "$rede" "${faixa:-—}" "${anexos:-0}"
done

secao 'VOLUMES'
docker volume ls 2>/dev/null

secao 'PROXY REVERSO — qual é e onde mora'
echo '— containers com cara de proxy —'
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}' 2>/dev/null \
  | grep -Ei 'traefik|nginx|caddy|proxy|haproxy' || echo '  (nenhum)'
echo; echo '— nginx no host —'
if tem nginx; then
  nginx -v 2>&1
  nginx -T 2>/dev/null | grep -E '^\s*(server_name|listen|proxy_pass|include)' | head -60 \
    || echo '  (sem permissão para ler a configuração — rode com sudo)'
else
  echo '  nginx não instalado no host (o proxy deve ser container)'
fi
echo; echo '— certificados existentes —'
ls -1 /etc/letsencrypt/live 2>/dev/null || echo '  (sem /etc/letsencrypt ou sem permissão)'

secao 'COOLIFY (o VerboPlus documenta uso de Coolify nesta VPS)'
docker ps -a --format '{{.Names}}' 2>/dev/null | grep -i coolify || echo '  (nenhum container coolify)'

secao 'PORTAS 8080-8099 (candidatas ao loopback do Veyra)'
if tem ss; then
  ss -ltn 2>/dev/null | awk 'NR>1 {print $4}' | grep -oE ':(80[8-9][0-9])$' | sort -u || echo '  (nenhuma ocupada na faixa)'
fi

secao 'FIM'
echo 'Nada foi alterado.'
