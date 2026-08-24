-- Sugestão de resposta por IA (ADR-044): a proposta de ENVIO é um tipo novo,
-- não uma tarefa. Cada tipo carrega a permissão de domínio do seu efeito
-- (`send_message` exige `conversations:write` de quem aprova), por isso o tipo
-- é dado de banco e não uma convenção no payload.
ALTER TYPE "AiProposalType" ADD VALUE IF NOT EXISTS 'send_message';
