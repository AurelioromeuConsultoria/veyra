-- B1 (ADR-061, adendo 8, ressalvas da revisão): o histórico dos vínculos de um
-- evento da agenda do Core.
--
-- O que faz, numa transação só (ADR-051): acrescenta o valor `event_linked`
-- ao tipo "ActivityType". A API grava uma atividade desse tipo a cada vínculo
-- que um evento passa a ter (contato, oportunidade e o contato dela no
-- momento); a regra do conteúdo protegido lê esse histórico, e a timeline não
-- o mostra. O valor NÃO é usado nesta transação (o Postgres não permite usar o
-- valor novo antes do COMMIT); a API só o grava depois de a migration
-- terminar. Só acréscimo: nenhuma linha, coluna ou restrição muda.
--
-- Locks: o ALTER TYPE ... ADD VALUE pega só a trava do tipo e do catálogo
-- (`pg_enum`), sem tocar em "Activity" nem em outra tabela. Espera por lock
-- limitada a 5 s; a execução é instantânea. É estimativa, não limite.
--
-- Se falhar: docs/DEPLOY_STAGING.md §4, "Falha de migration", nunca
-- `migrate resolve --rolled-back` às cegas. A transação desfaz tudo; o
-- inventário de lá deve dar zero.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- AlterEnum
ALTER TYPE "ActivityType" ADD VALUE 'event_linked';

COMMIT;
