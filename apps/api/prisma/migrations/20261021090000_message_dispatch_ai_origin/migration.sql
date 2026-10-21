-- ADR-047 adendo 7 §9 (G3.2), decisão do usuário de 2026-10-21: editar ou
-- aprovar uma sugestão da IA não remove a origem de IA nem a proteção da
-- guarda. A origem fica explícita no despacho; a autoria (Message.authorType)
-- continua a mesma. Aditiva: NOT NULL com DEFAULT constante só altera o
-- catálogo no Postgres 11+, sem reescrever a tabela; linhas antigas = false.
ALTER TABLE "MessageDispatch" ADD COLUMN "fromAiProposal" BOOLEAN NOT NULL DEFAULT false;
