/**
 * As CLIs administrativas sobem o `AppModule` inteiro. Sem isto, abririam no
 * próprio processo os workers do outbox, as varreduras e a reconciliação da
 * subida, e um encerramento no meio de uma entrega viraria `in_doubt` (achado
 * da revisão final da G4, ADR-047 adendo 7 §10). Importado ANTES do
 * `AppModule`: a configuração validada é lida na importação dele.
 */
process.env.DISABLE_JOBS = 'true';

export {};
