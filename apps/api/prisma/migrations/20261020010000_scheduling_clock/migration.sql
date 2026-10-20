-- Relógio de agendamento (ADR-049): quem compara define o relógio, e filas e
-- leases usam o do BANCO.
--
-- O Prisma 7 preenche `@default(now())` e `@updatedAt` no CLIENTE, com o
-- relógio do Node. Dois pares eram mistos:
--   1. `OutboxEvent.nextRetryAt` nascia com o relógio do Node, e o claim compara
--      `"nextRetryAt" <= now()`. Com o Node adiantado, evento novo ficava
--      invisível pelo tamanho do desvio (falha demonstrada: +19,4 s).
--   2. `MessageDispatch.updatedAt` era escrito pelo Node, e a varredura compara
--      `"updatedAt" < now() - 15 min`. Com o Node atrasado, despacho que
--      aguardava nova tentativa era enterrado antes da hora.
--
-- Nos dois, o banco passa a escrever. O DEFAULT cobre a criação
-- (`transaction_timestamp()` é o mesmo instante de `now()`; escrito assim porque
-- o Prisma lê `CURRENT_TIMESTAMP` como o `now()` DELE e acusaria drift); para o
-- despacho, um trigger grava `now()` em todo UPDATE cujo valor novo da coluna
-- é IGUAL ao antigo — o caso de quem não a define. Quem grava um valor
-- diferente (as varreduras em SQL, com `now()`) tem o valor respeitado.
-- Nenhum dado muda.
--
-- DEPLOY: esta migration roda ANTES do código novo, que deixa de enviar
-- `updatedAt` na criação do despacho (sem o DEFAULT, o NOT NULL recusaria).
-- O código antigo funciona com ela: manda os valores explícitos, e o trigger
-- os respeita (docs/DEPLOY_STAGING.md §4).

CREATE OR REPLACE FUNCTION "message_dispatch_touch_updated_at"() RETURNS trigger AS $$
BEGIN
  IF NEW."updatedAt" IS NOT DISTINCT FROM OLD."updatedAt" THEN
    NEW."updatedAt" := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ALTER TABLE e CREATE TRIGGER pedem lock forte em tabelas escritas o tempo
-- todo: com uma transação longa aberta, a fila de locks pararia as escritas.
-- Melhor falhar em 5s; se falhar (P3009), `prisma migrate resolve
-- --rolled-back <esta migration>` e repita o deploy (docs/DEPLOY_STAGING.md §4).
SET lock_timeout = '5s';

-- MessageDispatch ANTES de OutboxEvent: é a ordem em que a aplicação trava as
-- duas (o envio insere o despacho e depois enfileira; a varredura atualiza o
-- despacho e depois lê o outbox). Na ordem inversa, um envio em voo durante o
-- deploy poderia entrar em deadlock com a migration.
ALTER TABLE "MessageDispatch" ALTER COLUMN "updatedAt" SET DEFAULT transaction_timestamp();

CREATE TRIGGER "MessageDispatch_touch_updated_at"
  BEFORE UPDATE ON "MessageDispatch"
  FOR EACH ROW EXECUTE FUNCTION "message_dispatch_touch_updated_at"();

ALTER TABLE "OutboxEvent" ALTER COLUMN "nextRetryAt" SET DEFAULT transaction_timestamp();

-- devolve o padrão para o resto da sessão do `migrate deploy`
RESET lock_timeout;
