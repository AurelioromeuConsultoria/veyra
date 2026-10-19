-- Estados TERMINAIS do outbox são definitivos (ADR-047, adendos 2 e 3).
--
-- A fotografia dos contatos (`subjectContactIds`) é zerada quando o evento chega
-- a `delivered` ou `dead`: ela só existe enquanto o evento ainda pode sair. Isso
-- só é seguro se nenhum caminho puder REABRIR um evento terminal para nova
-- entrega — um replay sem a fotografia entregaria sem a restrição de conteúdo.
--
-- Hoje nenhum código faz isso (o claim só pega `pending` e `processing` com lease
-- vencido; as conclusões exigem `processing` e o token dono), e não existe
-- reenvio manual. Este trigger transforma o "hoje ninguém faz" em garantia, que
-- vale também para SQL manual: tirar um evento de `delivered`/`dead`, ou
-- devolver fotografia a ele, é recusado pelo banco. Um reenvio manual futuro
-- precisa de ADR e de preservar a fotografia até não ser mais possível reenviar.

CREATE OR REPLACE FUNCTION "outbox_terminal_is_final"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" IN ('delivered', 'dead') THEN
    IF NEW."status" IS DISTINCT FROM OLD."status" THEN
      RAISE EXCEPTION 'OutboxEvent em estado terminal (%) não pode ser reaberto', OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."subjectContactIds" IS NOT NULL AND OLD."subjectContactIds" IS NULL THEN
      RAISE EXCEPTION 'OutboxEvent terminal não recebe fotografia de contatos de volta'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- CREATE TRIGGER pede SHARE ROW EXCLUSIVE na tabela mais escrita do sistema:
-- com uma transação longa aberta, a fila de locks pararia as escritas. Melhor
-- falhar em 5s; se falhar (P3009), `prisma migrate resolve --rolled-back <esta
-- migration>` e repita o deploy (runbook: docs/DEPLOY_STAGING.md §4).
SET lock_timeout = '5s';

CREATE TRIGGER "OutboxEvent_terminal_is_final"
  BEFORE UPDATE ON "OutboxEvent"
  FOR EACH ROW EXECUTE FUNCTION "outbox_terminal_is_final"();

-- devolve o padrão para o resto da sessão do `migrate deploy`
RESET lock_timeout;
