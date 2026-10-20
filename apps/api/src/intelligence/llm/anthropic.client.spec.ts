import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { AnthropicClient, OPCOES_DO_SDK } from './anthropic.client';

/**
 * O SDK da IA sob a guarda de uso externo (ADR-047 adendo 6 §4 e §10.11, G3.1):
 * prazo de 60 s, NENHUMA retentativa automática, e o sinal de aborto da guarda
 * chegando à chamada. Nenhuma chamada sai: o `messages.create` é substituído.
 */
describe('cliente do provedor de IA', () => {
  const config = (valores: Record<string, string>) =>
    ({ get: (chave: string) => valores[chave] }) as unknown as ConfigService;

  it('o SDK nasce com prazo de 60 s e sem retentativa automática', () => {
    expect(OPCOES_DO_SDK).toEqual({ timeout: 60_000, maxRetries: 0 });
    const cliente = new AnthropicClient(config({ ANTHROPIC_API_KEY: 'sk-ficticia' }));
    expect(cliente.sdk?.maxRetries).toBe(0);
    expect(cliente.sdk?.timeout).toBe(60_000);
  });

  it('a chamada leva o sinal da guarda e as mesmas opções; lançar depois de despachar é incerto', async () => {
    const cliente = new AnthropicClient(config({ ANTHROPIC_API_KEY: 'sk-ficticia' }));
    const chamadas: unknown[][] = [];
    const sdk = cliente.sdk as unknown as { messages: { create: (...args: unknown[]) => unknown } };
    sdk.messages.create = async (...args: unknown[]) => {
      chamadas.push(args);
      return {
        content: [{ type: 'text', text: '{}' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    };
    const controle = new AbortController();
    const pedido = { system: 's', context: 'c', maxOutputTokens: 10 };
    expect(await cliente.complete(pedido, controle.signal)).toMatchObject({ kind: 'ok' });
    expect(chamadas[0][1]).toEqual({ signal: controle.signal, ...OPCOES_DO_SDK });

    sdk.messages.create = async () => {
      throw Object.assign(new Error('abortado'), { name: 'APIUserAbortError' });
    };
    expect(await cliente.complete(pedido, controle.signal)).toEqual({
      kind: 'unknown_after_dispatch',
    });
  });

  it('sem chave, nenhuma chamada sai', async () => {
    const cliente = new AnthropicClient(config({}));
    expect(cliente.sdk).toBeNull();
    expect(
      await cliente.complete(
        { system: 's', context: 'c', maxOutputTokens: 10 },
        new AbortController().signal,
      ),
    ).toEqual({ kind: 'no_provider' });
  });

  it('só a guarda chama o provedor sem reconferir (`completeUnderGuard`)', () => {
    const raiz = join(__dirname, '..', '..');
    const achados: string[] = [];
    const varrer = (dir: string) => {
      for (const entrada of readdirSync(dir, { withFileTypes: true })) {
        const caminho = join(dir, entrada.name);
        if (entrada.isDirectory()) {
          if (entrada.name !== 'generated') varrer(caminho);
        } else if (entrada.name.endsWith('.ts') && !entrada.name.includes('spec')) {
          if (readFileSync(caminho, 'utf8').includes('completeUnderGuard(')) {
            achados.push(caminho.slice(raiz.length));
          }
        }
      }
    };
    varrer(raiz);
    // a definição, e a única chamada: dentro de `callUnderGuard`, como `call` da guarda
    expect(achados.sort()).toEqual([
      '/intelligence/intelligence.service.ts',
      '/intelligence/llm/llm.gateway.ts',
    ]);
  });
});
