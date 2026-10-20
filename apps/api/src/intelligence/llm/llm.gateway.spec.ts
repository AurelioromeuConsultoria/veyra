import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ContentRestrictionService } from '../../extensions/content-restriction';
import type { LlmClient, LlmRequest } from './llm.client';
import { LlmGateway } from './llm.gateway';

const WS = '6f1c2a5e-0b8e-4c1f-9a3d-2b7e8f9a0c1d';

class SpyProvider implements LlmClient {
  readonly model = 'fake';
  calls: LlmRequest[] = [];
  sinais: AbortSignal[] = [];
  async complete(request: LlmRequest, signal: AbortSignal) {
    this.calls.push(request);
    this.sinais.push(signal);
    return { kind: 'ok' as const, text: '{}', inputTokens: 1, outputTokens: 1 };
  }
}

const base = { system: 's', context: 'c', maxOutputTokens: 10 };

describe('LlmGateway — ponto único até o provedor (ADR-047 E6)', () => {
  const restrictedIds = new Set<string | null>();
  const restriction = new ContentRestrictionService([
    { restricted: async (_ws, _consumer, subjects) => subjects.map((s) => restrictedIds.has(s)) },
  ]);
  let provider: SpyProvider;
  let gateway: LlmGateway;

  beforeEach(() => {
    restrictedIds.clear();
    provider = new SpyProvider();
    gateway = new LlmGateway(provider, restriction);
  });

  it('pedido SEM escopo, ou com escopo VAZIO, é restrito — declarar "nenhum contato" não é atalho', async () => {
    expect(await gateway.verdict(undefined)).toBe('restricted');
    expect(await gateway.verdict({ workspaceId: WS, contactIds: [] })).toBe('restricted');
    expect(provider.calls).toEqual([]);
  });

  it('contato restrito é restrito; liberado é permitido', async () => {
    restrictedIds.add('c1');
    expect(await gateway.verdict({ workspaceId: WS, contactIds: ['c1'] })).toBe('restricted');
    expect(await gateway.verdict({ workspaceId: WS, contactIds: ['c2'] })).toBe('allowed');
    expect(provider.calls).toEqual([]);
  });

  it('sob a guarda: o provedor recebe o pedido SEM o escopo, e o sinal de aborto da guarda', async () => {
    const controle = new AbortController();
    await gateway.completeUnderGuard(
      { ...base, scope: { workspaceId: WS, contactIds: ['c2'] } },
      controle.signal,
    );
    expect(provider.calls).toEqual([base]);
    expect(provider.sinais).toEqual([controle.signal]);
  });

  it('não existe chamada ao provedor fora da guarda: o gateway só tem `completeUnderGuard`', () => {
    expect((gateway as unknown as Record<string, unknown>).complete).toBeUndefined();
    const fonte = readFileSync(join(__dirname, 'llm.gateway.ts'), 'utf8');
    // a única chamada ao provedor está dentro de `completeUnderGuard`
    const chamadas = [...fonte.matchAll(/this\.provider\.complete\(/g)];
    expect(chamadas).toHaveLength(1);
    const dono = fonte.lastIndexOf('completeUnderGuard(', chamadas[0].index);
    expect(fonte.slice(dono, chamadas[0].index)).not.toMatch(/\n {2}[a-zA-Z]+\(/);
  });

  it('só o gateway injeta o provedor: ninguém mais na API cita o provedor', () => {
    // a API INTEIRA, não só o módulo: um service de outro domínio que injetasse
    // o cliente do provedor contornaria o gateway
    const src = join(__dirname, '..', '..');
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) return entry === 'generated' ? [] : walk(full);
        return /\.ts$/.test(entry) && !/\.(spec|integration-spec)\.ts$/.test(entry) ? [full] : [];
      });
    const PROVIDER = /\bLLM_CLIENT\b|\bAnthropicClient\b|@anthropic-ai\/sdk/;
    // só CÓDIGO conta: comentário que cita o padrão (ex.: "mesmo desenho do
    // LLM_CLIENT") não injeta nada
    const semComentarios = (code: string) =>
      code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const usam = walk(src)
      .filter((file) => PROVIDER.test(semComentarios(readFileSync(file, 'utf8'))))
      .map((file) => file.slice(src.length + 1))
      .sort();
    // declaração da porta, adaptador do provedor, binding no módulo e o gateway
    expect(usam).toEqual([
      'intelligence/intelligence.module.ts',
      'intelligence/llm/anthropic.client.ts',
      'intelligence/llm/llm.client.ts',
      'intelligence/llm/llm.gateway.ts',
    ]);
  });

  it('toda rota de CAPACIDADE com @Idempotent declara guarda de replay', () => {
    const controller = readFileSync(join(__dirname, '..', 'intelligence.controller.ts'), 'utf8');
    // cada rota: o bloco de decorators que antecede o @Post de capacidade
    const routes = [...controller.matchAll(/((?:\s*@\w+\([^)]*\)\s*)+)@Post\('([^']+)'\)/g)];
    const capacidades = routes.filter(([, , path]) =>
      /summary|next-action|reply-suggestion/.test(path),
    );
    expect(capacidades.length).toBe(3);
    for (const [, decorators, path] of capacidades) {
      if (/@Idempotent\(/.test(decorators)) {
        expect(`${path}: ${/replayGuard/.test(decorators)}`).toBe(`${path}: true`);
      }
    }
  });
});
