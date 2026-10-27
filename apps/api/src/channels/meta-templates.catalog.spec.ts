import { ConfigService } from '@nestjs/config';
import { GraphTemplateCatalog } from './meta-templates.catalog';
import { MENSAGEM_DO_TETO, type call } from './meta.transport';

/**
 * A leitura do catálogo pela Graph API (F4.1c-2), sem rede: o cliente HTTP é
 * substituído, e o que se fixa é a URL pedida e a interpretação da resposta.
 * Não é exercitada contra a Meta real (envio e dados reais bloqueados).
 */
describe('o catálogo de templates pela Graph API (F4.1c-2)', () => {
  const config = { get: () => 'v21.0' } as unknown as ConfigService;
  const resposta = (status: number, corpo: unknown) => ({
    status,
    body: Buffer.from(typeof corpo === 'string' ? corpo : JSON.stringify(corpo)),
  });
  const com = (impl: (url: string) => unknown) => {
    const chamadas: { url: string; method: string; token: string }[] = [];
    const chamar = (async (url: string, o: { method: string; token: string }) => {
      chamadas.push({ url, method: o.method, token: o.token });
      return impl(url);
    }) as unknown as typeof call;
    return { catalogo: new GraphTemplateCatalog(config, chamar), chamadas };
  };
  const TEMPLATE = {
    id: '123',
    name: 'lembrete',
    language: 'pt_BR',
    status: 'APPROVED',
    category: 'UTILITY',
    parameter_format: 'POSITIONAL',
    components: [{ type: 'BODY', text: 'Ola {{1}}' }],
    quality_score: { score: 'GREEN' },
  };
  const CRED = { businessAccountId: '777', token: 'tok' };
  const PRIMEIRA =
    'https://graph.facebook.com/v21.0/777/message_templates?name=lembrete&language=pt_BR' +
    '&fields=id,name,language,status,category,parameter_format,components&limit=100';

  it('busca na WABA pelo nome e pelo idioma; só os campos pedidos, com o token', async () => {
    const { catalogo, chamadas } = com(() =>
      resposta(200, { data: [{ ...TEMPLATE, language: 'en_US', id: '9' }, TEMPLATE] }),
    );
    expect(await catalogo.buscarPorNome(CRED, 'lembrete', 'pt_BR')).toEqual({
      tipo: 'achado',
      template: {
        id: '123',
        name: 'lembrete',
        language: 'pt_BR',
        status: 'APPROVED',
        category: 'UTILITY',
        parameterFormat: 'POSITIONAL',
        components: TEMPLATE.components,
      },
    });
    expect(chamadas).toEqual([{ url: PRIMEIRA, method: 'GET', token: 'tok' }]);
  });

  it('segue a paginação pelo cursor, sobre a URL da primeira página; ausente só com a listagem percorrida; páginas demais é falha', async () => {
    // o `next` aponta para outro lugar, com o token na query: nada dele é usado
    const proxima =
      'https://outro.fbsbx.com/v21.0/888/message_templates?access_token=vazou&after=abc';
    const paginado = com((url) =>
      url === PRIMEIRA
        ? resposta(200, {
            data: [{ ...TEMPLATE, name: 'lembrete_2' }],
            paging: { next: proxima, cursors: { after: 'abc' } },
          })
        : resposta(200, { data: [TEMPLATE] }),
    );
    expect(await paginado.catalogo.buscarPorNome(CRED, 'lembrete', 'pt_BR')).toMatchObject({
      tipo: 'achado',
      template: { id: '123' },
    });
    expect(paginado.chamadas.map((c) => c.url)).toEqual([PRIMEIRA, `${PRIMEIRA}&after=abc`]);
    expect(
      await com(() => resposta(200, { data: [] })).catalogo.buscarPorNome(CRED, 'x', 'pt_BR'),
    ).toEqual({ tipo: 'ausente' });
    const sempre = com(() =>
      resposta(200, { data: [], paging: { next: proxima, cursors: { after: 'abc' } } }),
    );
    expect(await sempre.catalogo.buscarPorNome(CRED, 'x', 'pt_BR')).toEqual({
      tipo: 'falha',
      failure: {},
      motivo: 'paginas',
    });
    expect(sempre.chamadas).toHaveLength(5);
    // o cursor é valor opaco: o que ele trouxer fica dentro do `after`
    const hostil = com((url) =>
      url === PRIMEIRA
        ? resposta(200, {
            data: [],
            paging: { next: proxima, cursors: { after: 'abc&fields=id#x' } },
          })
        : resposta(200, { data: [] }),
    );
    await hostil.catalogo.buscarPorNome(CRED, 'lembrete', 'pt_BR');
    expect(hostil.chamadas.map((c) => c.url)).toEqual([
      PRIMEIRA,
      `${PRIMEIRA}&after=abc%26fields%3Did%23x`,
    ]);
    // há próxima página, mas sem cursor: não se segue o `next` como veio
    expect(
      await com(() =>
        resposta(200, { data: [], paging: { next: proxima } }),
      ).catalogo.buscarPorNome(CRED, 'x', 'pt_BR'),
    ).toEqual({ tipo: 'falha', failure: { status: 200 }, motivo: 'paginas' });
  });

  it('erro da Meta: falha com o status e o código numérico; teto, rede e corpo inválido', async () => {
    expect(
      await com(() => resposta(401, { error: { code: 190 } })).catalogo.buscarPorNome(
        CRED,
        'x',
        'pt_BR',
      ),
    ).toEqual({ tipo: 'falha', failure: { status: 401, metaCode: 190 } });
    // o código que não é número não entra (a CLI o imprimiria)
    expect(
      await com(() => resposta(400, { error: { code: 'texto livre' } })).catalogo.buscarPorNome(
        CRED,
        'x',
        'pt_BR',
      ),
    ).toEqual({ tipo: 'falha', failure: { status: 400 } });
    expect(
      await com(() => {
        throw new Error(MENSAGEM_DO_TETO);
      }).catalogo.buscarPorNome(CRED, 'x', 'pt_BR'),
    ).toEqual({ tipo: 'falha', failure: {}, motivo: 'teto' });
    expect(
      await com(() => {
        throw new Error('timeout');
      }).catalogo.buscarPorNome(CRED, 'x', 'pt_BR'),
    ).toEqual({ tipo: 'falha', failure: { networkFailure: true } });
    expect(
      await com(() => resposta(200, 'não é json')).catalogo.buscarPorNome(CRED, 'x', 'pt_BR'),
    ).toEqual({ tipo: 'falha', failure: { status: 200 } });
  });

  it('o template com o nome e o idioma, mas incompleto ou de id estranho, é falha, não ausência', async () => {
    for (const quebrado of [
      { name: 'lembrete', language: 'pt_BR', id: '1' },
      { ...TEMPLATE, id: '../me' },
    ]) {
      expect(
        await com(() => resposta(200, { data: [quebrado] })).catalogo.buscarPorNome(
          CRED,
          'lembrete',
          'pt_BR',
        ),
      ).toEqual({ tipo: 'falha', failure: { status: 200 } });
    }
  });

  it('a WABA que não é id da Meta nem chega a ser lida', async () => {
    const { catalogo, chamadas } = com(() => resposta(200, { data: [TEMPLATE] }));
    expect(
      await catalogo.buscarPorNome({ ...CRED, businessAccountId: '../me' }, 'x', 'pt_BR'),
    ).toEqual({ tipo: 'falha', failure: {}, motivo: 'id_invalido' });
    expect(chamadas).toEqual([]);
  });
});
