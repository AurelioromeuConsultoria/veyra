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

  it('2xx SEM id de mensagem é AMBÍGUO: a Meta aceitou e não devolveu o id', () => {
    // era o pior caminho possível: o catch-all devolvia `retryable`, e reenviar
    // duplicaria uma mensagem provavelmente entregue
    expect(classifyFailure({ status: 200 })).toBe('ambiguous');
    expect(classifyFailure({ status: 201 })).toBe('ambiguous');
  });

  it('408 é ambíguo — timeout do lado do servidor', () => {
    expect(classifyFailure({ status: 408 })).toBe('ambiguous');
  });

  it('limites de taxa que vêm com 400 são RETENTÁVEIS, apesar do status', () => {
    expect(classifyFailure({ status: 400, metaCode: 130_429 })).toBe('retryable');
    expect(classifyFailure({ status: 400, metaCode: 131_048 })).toBe('retryable');
    expect(classifyFailure({ status: 400, metaCode: 131_056 })).toBe('retryable');
  });
});
