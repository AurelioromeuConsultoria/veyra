/**
 * Contrato do healthcheck (GET /api/health).
 * Convenção do pacote: schemas Zod = entrada; interfaces = DTO de saída.
 */
export interface HealthDto {
  status: 'ok';
  service: 'veyra-api';
  timestamp: string;
}
