import { classifyFailure } from './meta-errors';

describe('classificação de falha de envio (ADR-039)', () => {
  it('rede caída é AMBÍGUA: pode ter chegado', () => {
    expect(classifyFailure({ networkFailure: true })).toBe('ambiguous');
  });

  it('5xx é ambíguo, mesmo que muitas vezes não tenha processado', () => {
    expect(classifyFailure({ status: 500 })).toBe('ambiguous');
    expect(classifyFailure({ status: 503 })).toBe('ambiguous');
  });

  it('429 é retentável — espera e tenta de novo', () => {
    expect(classifyFailure({ status: 429 })).toBe('retryable');
  });

  it('credencial recusada é PERMANENTE: seis retries repetiriam o erro', () => {
    expect(classifyFailure({ status: 401 })).toBe('permanent');
    expect(classifyFailure({ status: 403 })).toBe('permanent');
    expect(classifyFailure({ status: 400, metaCode: 190 })).toBe('permanent');
  });

  it('template inválido é permanente', () => {
    expect(classifyFailure({ status: 400, metaCode: 132_001 })).toBe('permanent');
    expect(classifyFailure({ status: 400, metaCode: 132_000 })).toBe('permanent');
  });

  it('4xx genérico é permanente: validação não melhora com retentativa', () => {
    expect(classifyFailure({ status: 400 })).toBe('permanent');
    expect(classifyFailure({ status: 404 })).toBe('permanent');
  });
});
