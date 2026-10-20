-- ADR-047 adendo 7 §3.6 e §9 (G3.1): o run da IA cujo uso externo ficou em
-- dúvida. Aditiva: só acrescenta o valor ao enum.
ALTER TYPE "AiRunStatus" ADD VALUE 'unknown_after_dispatch';
