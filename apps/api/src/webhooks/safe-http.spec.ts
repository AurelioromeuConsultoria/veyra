import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UnsafeUrlError, assertPublicIp, assertSafeWebhookUrl, safePost } from './safe-http';

/** Defesa SSRF (ajuste #6): classificação por ipaddr.js, nunca regex. */
describe('safe-http — defesa SSRF', () => {
  it('rejeita loopback, privado, link-local e metadados de nuvem', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.5',
      '192.168.1.1',
      '169.254.169.254', // metadata de cloud — o alvo clássico de SSRF
      '0.0.0.0',
      '::1',
      'fd00::1', // unique local IPv6
      'fe80::1', // link-local IPv6
      '100.64.0.1', // CGNAT
    ]) {
      expect(() => assertPublicIp(address)).toThrow(UnsafeUrlError);
    }
  });

  it('rejeita IPv4 MAPEADO em IPv6 (bypass clássico)', () => {
    expect(() => assertPublicIp('::ffff:127.0.0.1')).toThrow(UnsafeUrlError);
    expect(() => assertPublicIp('::ffff:169.254.169.254')).toThrow(UnsafeUrlError);
  });

  it('aceita endereços públicos', () => {
    expect(() => assertPublicIp('93.184.216.34')).not.toThrow();
    expect(() => assertPublicIp('2606:2800:220:1:248:1893:25c8:1946')).not.toThrow();
  });

  it('URL: exige https, sem credenciais, e barra host literal interno', () => {
    expect(() => assertSafeWebhookUrl('http://exemplo.com/hook')).toThrow(/https/);
    expect(() => assertSafeWebhookUrl('https://user:pass@exemplo.com/hook')).toThrow(/credenciais/);
    expect(() => assertSafeWebhookUrl('https://127.0.0.1/hook')).toThrow(UnsafeUrlError);
    expect(() => assertSafeWebhookUrl('https://[::1]/hook')).toThrow(UnsafeUrlError);
    expect(() => assertSafeWebhookUrl('não-é-url')).toThrow(/inválida/);
    expect(() => assertSafeWebhookUrl('https://exemplo.com/hook')).not.toThrow();
  });
});

describe('safePost — pinning de IP na conexão real', () => {
  it('o sinal da guarda aborta a entrega já na resolução de DNS (ADR-047 adendo 7 §9, G3.3)', async () => {
    const controle = new AbortController();
    controle.abort();
    await expect(
      safePost('https://nao-existe.veyra-teste.invalid/hook', '{}', {}, controle.signal),
    ).rejects.toThrow(/abortada pelo prazo/);
  });

  it('host que RESOLVE para loopback é recusado antes de conectar', async () => {
    // 'localhost' resolve para 127.0.0.1/::1 — o cenário do rebinding: a URL
    // parece inocente, a resolução é que denuncia. Se o pinning não valesse,
    // a conexão aconteceria.
    await expect(safePost('https://localhost:9/hook', '{}', {})).rejects.toThrow(UnsafeUrlError);
  });

  it('host inexistente falha na resolução, sem conectar', async () => {
    await expect(
      safePost('https://nao-existe.veyra-teste.invalid/hook', '{}', {}),
    ).rejects.toThrow();
  });
});

/**
 * Regra estática da G3.3 (ADR-047 adendo 7 §9): nenhum POST de webhook sai sem
 * a guarda de uso externo. O transporte real só é chamado pela própria
 * definição; o injetável, só pelo serviço de webhooks, uma vez, dentro do
 * `iniciar` da guarda. Uma reentrega manual ou um "testar webhook" futuro que
 * chamasse o transporte direto quebra aqui.
 */
describe('regra estática: só a guarda chama o transporte do webhook', () => {
  const raiz = join(__dirname, '..');
  const arquivosCom = (trecho: string): string[] => {
    const achados: string[] = [];
    const varrer = (dir: string) => {
      for (const entrada of readdirSync(dir, { withFileTypes: true })) {
        const caminho = join(dir, entrada.name);
        if (entrada.isDirectory()) {
          if (entrada.name !== 'generated') varrer(caminho);
        } else if (entrada.name.endsWith('.ts') && !entrada.name.includes('spec')) {
          if (readFileSync(caminho, 'utf8').includes(trecho))
            achados.push(caminho.slice(raiz.length));
        }
      }
    };
    varrer(raiz);
    return achados.sort();
  };

  it('`safePost(` só aparece na própria definição', () => {
    expect(arquivosCom('safePost(')).toEqual(['/webhooks/safe-http.ts']);
  });

  it('o transporte injetável só é usado pelo módulo e pelo serviço de webhooks', () => {
    expect(arquivosCom('WEBHOOK_TRANSPORT')).toEqual([
      '/webhooks/webhooks.module.ts',
      '/webhooks/webhooks.service.ts',
    ]);
  });

  it('o serviço chama o transporte UMA vez, dentro do `iniciar` da guarda', () => {
    const texto = readFileSync(join(raiz, 'webhooks', 'webhooks.service.ts'), 'utf8');
    const chamadas = texto.split('\n').filter((linha) => linha.includes('this.transport('));
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]).toMatch(/^\s*iniciar: \(signal\) => this\.transport\(/);
  });
});
