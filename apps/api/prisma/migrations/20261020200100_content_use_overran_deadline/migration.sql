-- Detector novo do uso externo (ADR-047 adendo 7, G1): a chamada passou do
-- prazo sem responder e pode começar depois. Aditiva: só um valor de enum.
ALTER TYPE "ContentUseDetector" ADD VALUE 'overran_deadline';
