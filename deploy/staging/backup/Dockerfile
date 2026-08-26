# syntax=docker/dockerfile:1.7
#
# Backup de banco e storage para destino EXTERNO. Uma ferramenta só (restic):
# ela já faz cifra em repouso, deduplicação, retenção e verificação de
# integridade — encadear `pg_dump | gzip | rclone` deixaria cada uma dessas
# quatro coisas por nossa conta.
#
# A cifra do restic importa aqui: staging tem dado fictício, mas o mesmo
# roteiro vai valer para produção, e um backup em claro num bucket de terceiro
# é o vazamento que ninguém vê acontecer.

FROM alpine:3.21

# postgresql17-client: a versão do `pg_dump` precisa ser >= a do servidor
RUN apk add --no-cache postgresql17-client restic ca-certificates tzdata tini \
 && addgroup -g 10001 -S veyra \
 && adduser -u 10001 -S -G veyra -h /home/veyra veyra \
 # o cache do restic é VOLUME NOMEADO: o Docker só herda o dono se o caminho
 # existir na imagem. Sem isto o volume nasce de root, o container roda como
 # veyra e o restic perde o cache a cada ciclo (ou falha, conforme o destino)
 && mkdir -p /home/veyra/.cache/restic \
 && chown -R veyra:veyra /home/veyra

COPY --chown=veyra:veyra backup.sh restore.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/backup.sh /usr/local/bin/restore.sh

USER veyra
WORKDIR /home/veyra
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/usr/local/bin/backup.sh", "--loop"]
