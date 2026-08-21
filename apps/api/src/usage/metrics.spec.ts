import { USAGE_METRICS } from './metrics';

/**
 * INVARIANTE DE CATÁLOGO. A regra do ADR-041 é genérica sobre `USAGE_METRICS`,
 * então apagar a marca de uma métrica devolve gasto sem teto e NENHUM teste de
 * comportamento reprova — a suíte inteira segue verde. Este é o guarda que
 * impede o P1 de voltar em silêncio (mesmo papel do spec de `WORKSPACE_MODELS`).
 */
describe('catálogo de métricas de uso (ADR-032, ADR-041)', () => {
  /**
   * Métricas cujo consumo gasta dinheiro em provedor de TERCEIRO. Sair desta
   * lista é decisão de produto e exige mexer aqui, à vista.
   */
  const CUSTO_DE_TERCEIRO = ['messages_sent', 'ai_runs', 'ai_cost_cents'];

  it('toda métrica de custo de terceiro nunca pode ficar sem teto', () => {
    for (const key of CUSTO_DE_TERCEIRO) {
      expect(USAGE_METRICS[key]?.neverUnlimited).toBe(true);
    }
  });

  it('métrica sem teto possível tem piso POSITIVO', () => {
    // piso zero bloquearia tudo — a alternativa que o ADR-041 descarta
    // explicitamente, porque transforma erro de configuração em produto parado
    for (const definition of Object.values(USAGE_METRICS)) {
      if (!definition.neverUnlimited) continue;
      expect(definition.safetyFloor).toBeGreaterThan(0);
    }
  });

  it('métrica interna NÃO é marcada: barrá-la puniria quem não decide cobrança', () => {
    expect(USAGE_METRICS.contacts.neverUnlimited).toBeUndefined();
    expect(USAGE_METRICS.storage_bytes.neverUnlimited).toBeUndefined();
  });

  it('toda métrica marcada é cobrada — marca sem enforcement não protege nada', () => {
    for (const definition of Object.values(USAGE_METRICS)) {
      if (definition.neverUnlimited) expect(definition.enforced).toBe(true);
    }
  });
});
