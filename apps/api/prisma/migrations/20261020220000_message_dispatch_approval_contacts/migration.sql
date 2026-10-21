-- ADR-047 adendo 7 §9 (G3.2): os contatos conferidos na APROVAÇÃO do rascunho
-- da IA ficam no despacho, e o envio trava e reconfere todos eles (somados ao
-- contato atual da conversa). Aditiva: coluna nova, sem FK (como
-- `ContentUse.contactIds`), validada na escrita e conferida pelo `check:fk`.
ALTER TABLE "MessageDispatch" ADD COLUMN "approvalContactIds" UUID[];
