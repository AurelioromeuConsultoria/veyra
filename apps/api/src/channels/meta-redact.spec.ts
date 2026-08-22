import { redigir, redigirTexto } from './meta-redact';

/**
 * Ferramenta de segurança tem teste: o valor dela é a garantia de que NADA
 * sensível sobrevive, e isso não se verifica olhando uma saída de exemplo.
 */
describe('redação de erro do provedor', () => {
  const erro = {
    error: {
      message: '(#131026) Message undeliverable to +5511999998888',
      type: 'OAuthException',
      code: 131026,
      fbtrace_id: 'AbCdEf123',
    },
    request: {
      headers: {
        Authorization: 'Bearer EAAGxyz123456789abcdef',
        'X-Hub-Signature-256': 'sha256=deadbeef',
      },
      body: {
        to: '5511999998888',
        messaging_product: 'whatsapp',
        template: { name: 'retorno_consulta', language: 'pt_BR' },
      },
    },
  };

  const saida = JSON.stringify(redigir(erro));

  it('nada de token, assinatura ou número sobrevive', () => {
    expect(saida).not.toContain('EAAGxyz123456789abcdef');
    expect(saida).not.toContain('Bearer EAAG');
    expect(saida).not.toContain('deadbeef');
    expect(saida).not.toContain('5511999998888');
    expect(saida).not.toContain('AbCdEf123');
  });

  it('o que serve para CORRIGIR a integração sobrevive', () => {
    // sem código, classificação e formato do template não há o que consertar
    expect(saida).toContain('131026');
    expect(saida).toContain('OAuthException');
    expect(saida).toContain('retorno_consulta');
    expect(saida).toContain('pt_BR');
    expect(saida).toContain('whatsapp');
  });

  it('chave DESCONHECIDA é redigida em QUALQUER tamanho: falha fechado', () => {
    /**
     * A primeira versão só redigia acima de 80 caracteres, e um segredo curto —
     * assinatura truncada, id interno, senha — passava inteiro. "Falha fechado"
     * era falso justamente no caso pequeno.
     */
    const inesperado = redigir({
      campo_novo_da_meta: 'x'.repeat(200),
      campo_curto: 'a1b2c3',
      senha_interna: 'hunter2',
    }) as Record<string, string>;
    expect(inesperado.campo_novo_da_meta).toBe('[REDIGIDO]');
    expect(inesperado.campo_curto).toBe('[REDIGIDO]');
    expect(inesperado.senha_interna).toBe('[REDIGIDO]');
  });

  it('segredo EMBUTIDO em texto preservado não sobrevive', () => {
    /**
     * A Meta ecoa pedaços da requisição dentro de `message`: um
     * `access_token=…` ali dentro sobrevivia a qualquer allowlist de chave, e um
     * segredo hexadecimal que não comece com EAA também.
     */
    const casos = redigir({
      message: 'Invalid OAuth access_token=abc123def456 for signature=deadbeefcafe',
      status: 'falhou com client_secret: s3gr3d0-mui-secreto',
      type: 'assinatura 9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928 inválida',
      reason: 'jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc',
    }) as Record<string, string>;

    const tudo = JSON.stringify(casos);
    expect(tudo).not.toContain('abc123def456');
    expect(tudo).not.toContain('deadbeefcafe');
    expect(tudo).not.toContain('s3gr3d0');
    expect(tudo).not.toContain('9f8e7d6c5b4a39281706f5e4d3c2b1a0');
    expect(tudo).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    // e o NOME do parâmetro fica, porque é ele que explica o erro
    expect(casos.message).toContain('access_token');
    expect(casos.message).toContain('Invalid OAuth');
  });

  it('mensagem útil da Meta continua legível', () => {
    const legivel = redigir({
      message: '(#132000) number of parameters does not match',
      code: 132000,
    }) as Record<string, unknown>;
    expect(legivel.message).toBe('(#132000) number of parameters does not match');
    expect(legivel.code).toBe(132000);
  });

  it('nome LONGO de template sobrevive: é o dado que conserta o item 6', () => {
    /**
     * Contrapeso dos padrões de sequência opaca: baixar o limiar para pegar JWT
     * comeria `confirmacao_de_consulta_amanha`, e sem o nome do template não há
     * como corrigir o formato — que é a maior incógnita da validação.
     */
    const alvo = redigir({
      name: 'confirmacao_de_consulta_amanha',
      language: 'pt_BR',
    }) as Record<string, string>;
    expect(alvo.name).toBe('confirmacao_de_consulta_amanha');
    expect(alvo.language).toBe('pt_BR');
  });

  it('texto solto (não-JSON) ainda perde token e número', () => {
    const bruto = 'curl -H "Authorization: Bearer EAAGsegredo123" -d to=+5511988887777';
    const limpo = redigirTexto(bruto);
    expect(limpo).not.toContain('EAAGsegredo123');
    expect(limpo).not.toContain('5511988887777');
    expect(limpo).toContain('curl');
  });
});
