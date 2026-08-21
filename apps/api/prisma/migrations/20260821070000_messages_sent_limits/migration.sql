-- `messages_sent` passa a ser COBRADA (Entrega 9.1.b): existe envio externo de
-- verdade, com custo do outro lado. Idempotente.
INSERT INTO "PlanLimit" ("planKey", "metric", "kind", "value") VALUES
  ('base', 'messages_sent', 'counter', 1000),
  ('pro',  'messages_sent', 'counter', 20000)
ON CONFLICT ("planKey", "metric") DO NOTHING;
