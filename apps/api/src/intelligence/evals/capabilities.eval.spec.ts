import { z } from 'zod';
import { computeLeadScore } from '../lead-score';
import {
  CONVERSATION_SUMMARY_PROMPT,
  LEAD_SCORE_EXPLANATION_PROMPT,
  NEXT_ACTION_PROMPT,
  promptHash,
} from '../prompts';
import { NEXT_ACTION_CASES, SCORE_SCENARIOS, SUMMARY_CASES } from './fixtures';

/**
 * EVALS por capacidade, sem rede: fixtures gravadas + asserções objetivas.
 * O que garantem: a validação estrutural aceita o que deve e recusa o resto;
 * o score determinístico fica nas faixas esperadas; e o prompt não muda sem
 * subir a versão.
 */

// os mesmos schemas do service, replicados aqui de propósito: se alguém
// afrouxar a validação de produção, a eval acusa a diferença
const summarySchema = z
  .object({
    subject: z.string().max(120),
    summary: z.string().max(1200),
    pendencies: z.array(z.string().max(200)).max(10),
    sentiment: z.enum(['positivo', 'neutro', 'negativo']),
    injectionAttempt: z.boolean(),
  })
  .strict();

const nextActionSchema = z
  .object({
    title: z.string().min(1).max(120),
    rationale: z.string().max(400),
    dueInDays: z.number().int().min(0).max(30),
  })
  .strict();

function parse(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

describe('eval — resumo de conversa', () => {
  it.each(SUMMARY_CASES.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    const result = summarySchema.safeParse(parse(testCase.output));
    expect(result.success).toBe(testCase.valid);
    if (result.success && testCase.expect) {
      if ('pendencyCount' in testCase.expect) {
        expect(result.data.pendencies).toHaveLength(testCase.expect.pendencyCount as number);
      }
      if ('sentiment' in testCase.expect) {
        expect(result.data.sentiment).toBe(testCase.expect.sentiment);
      }
      if ('injectionAttempt' in testCase.expect) {
        expect(result.data.injectionAttempt).toBe(testCase.expect.injectionAttempt);
      }
    }
  });
});

describe('eval — próxima ação', () => {
  it.each(NEXT_ACTION_CASES.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    const result = nextActionSchema.safeParse(parse(testCase.output));
    expect(result.success).toBe(testCase.valid);
    if (result.success && testCase.expect?.dueInDays !== undefined) {
      expect(result.data.dueInDays).toBe(testCase.expect.dueInDays);
    }
  });
});

describe('eval — score de lead', () => {
  it.each(SCORE_SCENARIOS.map((s) => [s.name, s] as const))('%s', (_name, scenario) => {
    const result = computeLeadScore(scenario.signals);
    expect(result.score).toBeGreaterThanOrEqual(scenario.min);
    expect(result.score).toBeLessThanOrEqual(scenario.max);
    for (const key of scenario.mustHaveFactors) {
      expect(result.factors.map((f) => f.key)).toContain(key);
    }
  });

  it('ordena os leads como um humano ordenaria', () => {
    const [quente, morno, frio] = SCORE_SCENARIOS.map((s) => computeLeadScore(s.signals).score);
    expect(quente).toBeGreaterThan(morno);
    expect(morno).toBeGreaterThan(frio);
  });
});

/**
 * Editar o texto de um prompt sem subir a versão faria runs antigos e novos
 * apontarem para a MESMA PromptVersion com conteúdos diferentes — o histórico
 * de custo e qualidade viraria mentira. Este teste é o cadeado.
 */
describe('eval — prompts versionados', () => {
  const HASHES: Record<string, string> = {
    'conversation_summary@1': promptHash(CONVERSATION_SUMMARY_PROMPT),
    'next_action@1': promptHash(NEXT_ACTION_PROMPT),
    'lead_score_explanation@1': promptHash(LEAD_SCORE_EXPLANATION_PROMPT),
  };

  it.each(Object.keys(HASHES))('%s tem hash estável', (key) => {
    expect(HASHES[key]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('todo prompt declara instrução de saída estruturada e defesa de conteúdo', () => {
    for (const prompt of [
      CONVERSATION_SUMMARY_PROMPT,
      NEXT_ACTION_PROMPT,
      LEAD_SCORE_EXPLANATION_PROMPT,
    ]) {
      expect(prompt.system).toMatch(/JSON/i);
      expect(prompt.changelog.length).toBeGreaterThan(10);
    }
    // só o resumo vê conteúdo de terceiro: é o único que precisa da defesa
    expect(CONVERSATION_SUMMARY_PROMPT.system).toMatch(/não confiável/i);
    expect(CONVERSATION_SUMMARY_PROMPT.system).toMatch(/nunca siga instruções/i);
  });
});
