import { createHash } from 'node:crypto';
import { canonizar } from './template-canonical';

/**
 * A forma canônica e o `contentHash` (ADR-052 item 4, F4.1c-2). O vetor é
 * escrito À MÃO, como o JSON canônico que deve sair: se a forma mudar, toda
 * revisão já feita deixa de valer, e este teste é o que avisa.
 */
const LEMBRETE = {
  name: 'lembrete_horario',
  language: 'pt_BR',
  category: 'UTILITY',
  parameterFormat: 'POSITIONAL',
  components: [
    { type: 'HEADER', format: 'TEXT', text: 'Oi {{1}}', example: { header_text: ['Ana'] } },
    {
      type: 'BODY',
      text: 'Seu horario esta confirmado, {{1}}.',
      example: { body_text: [['Ana']] },
    },
    { type: 'FOOTER', text: 'Clinica Ficticia' },
    {
      type: 'BUTTONS',
      buttons: [
        { type: 'QUICK_REPLY', text: 'Confirmar' },
        { type: 'URL', text: 'Mapa', url: 'https://exemplo.test/mapa' },
        { type: 'PHONE_NUMBER', text: 'Ligar', phone_number: '+5511900000000' },
      ],
    },
  ],
};
const VINCULOS = { 'body.1': 'contato.nome', 'header.1': 'contato.nome' };

const sha256 = (texto: string) => createHash('sha256').update(texto).digest('hex');

describe('a forma canônica dos templates (F4.1c-2)', () => {
  it('o hash é o SHA-256 do JSON canônico escrito à mão: chaves ordenadas, sem `example`, componentes na ordem', () => {
    const r = canonizar(LEMBRETE, VINCULOS);
    const esperado =
      '{"bindings":{"body.1":"contato.nome","header.1":"contato.nome"},' +
      '"category":"utility",' +
      '"components":[' +
      '{"format":"text","text":"Oi {{1}}","type":"header"},' +
      '{"text":"Seu horario esta confirmado, {{1}}.","type":"body"},' +
      '{"text":"Clinica Ficticia","type":"footer"},' +
      '{"buttons":[{"text":"Confirmar","type":"quick_reply"},' +
      '{"text":"Mapa","type":"url","url":"https://exemplo.test/mapa"},' +
      '{"phoneNumber":"+5511900000000","text":"Ligar","type":"phone_number"}],"type":"buttons"}],' +
      '"language":"pt_BR","name":"lembrete_horario","parameterFormat":"positional"}';
    expect(r).toMatchObject({ ok: true, contentHash: sha256(esperado) });
  });

  it('a ordem das chaves e o `example` não mudam o hash; a ordem dos componentes, os vínculos e a categoria mudam', () => {
    const base = canonizar(LEMBRETE, VINCULOS);
    const semExemplo = canonizar(
      {
        ...LEMBRETE,
        components: LEMBRETE.components.map((c) => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { example, ...resto } = c as Record<string, unknown>;
          return Object.fromEntries(Object.entries(resto).reverse());
        }),
      },
      { 'header.1': 'contato.nome', 'body.1': 'contato.nome' },
    );
    expect(semExemplo).toEqual(base);
    const hash = (r: ReturnType<typeof canonizar>) => (r.ok ? r.contentHash : r.motivo);
    const trocados = canonizar(
      {
        ...LEMBRETE,
        components: [
          LEMBRETE.components[1],
          LEMBRETE.components[0],
          ...LEMBRETE.components.slice(2),
        ],
      },
      VINCULOS,
    );
    expect(hash(trocados)).not.toBe(hash(base));
    expect(hash(canonizar({ ...LEMBRETE, category: 'MARKETING' }, VINCULOS))).not.toBe(hash(base));
    expect(
      hash(
        canonizar(
          { ...LEMBRETE, components: [LEMBRETE.components[1]] },
          { 'body.1': 'contato.nome' },
        ),
      ),
    ).not.toBe(hash(base));
  });

  it('sem parâmetros, sem vínculos; o parâmetro repetido no texto é um só; o formato nomeado', () => {
    expect(
      canonizar({ ...LEMBRETE, components: [{ type: 'BODY', text: 'Sem parametros.' }] }, {}),
    ).toMatchObject({ ok: true, forma: { bindings: {} } });
    expect(
      canonizar(
        { ...LEMBRETE, components: [{ type: 'BODY', text: '{{1}}, ate logo, {{1}}.' }] },
        { 'body.1': 'contato.nome' },
      ),
    ).toMatchObject({ ok: true });
    expect(
      canonizar(
        {
          ...LEMBRETE,
          parameterFormat: 'NAMED',
          components: [{ type: 'BODY', text: 'Oi {{nome_do_contato}}.' }],
        },
        { 'body.nome_do_contato': 'contato.nome' },
      ),
    ).toMatchObject({ ok: true, forma: { parameterFormat: 'named' } });
    // ausente, o formato é o posicional (o padrão da Meta)
    const semFormato = { ...LEMBRETE, parameterFormat: undefined };
    expect(canonizar(semFormato, VINCULOS)).toEqual(canonizar(LEMBRETE, VINCULOS));
  });

  it.each([
    ['a categoria authentication', { category: 'AUTHENTICATION' }, VINCULOS, 'categoria_recusada'],
    ['uma categoria desconhecida', { category: 'OUTRA' }, VINCULOS, 'categoria_recusada'],
    [
      'um formato de parâmetro desconhecido',
      { parameterFormat: 'MISTO' },
      VINCULOS,
      'formato_recusado',
    ],
    [
      'o cabeçalho de mídia',
      {
        components: [
          { type: 'HEADER', format: 'IMAGE', text: 'Oi', example: { header_handle: ['h'] } },
          LEMBRETE.components[1],
        ],
      },
      { 'body.1': 'contato.nome' },
      'componente_recusado',
    ],
    [
      'o botão de URL com sufixo dinâmico',
      {
        components: [
          LEMBRETE.components[1],
          {
            type: 'BUTTONS',
            buttons: [{ type: 'URL', text: 'Ver', url: 'https://exemplo.test/{{1}}' }],
          },
        ],
      },
      { 'body.1': 'contato.nome' },
      'componente_recusado',
    ],
    [
      'o botão de outro tipo',
      {
        components: [
          LEMBRETE.components[1],
          { type: 'BUTTONS', buttons: [{ type: 'COPY_CODE', example: 'X' }] },
        ],
      },
      { 'body.1': 'contato.nome' },
      'componente_recusado',
    ],
    [
      'o componente desconhecido',
      { components: [LEMBRETE.components[1], { type: 'CAROUSEL', cards: [] }] },
      { 'body.1': 'contato.nome' },
      'componente_recusado',
    ],
    ['sem corpo', { components: [{ type: 'FOOTER', text: 'Rodape' }] }, {}, 'componente_recusado'],
    [
      'o parâmetro no rodapé',
      { components: [LEMBRETE.components[1], { type: 'FOOTER', text: 'Ate {{1}}' }] },
      { 'body.1': 'contato.nome' },
      'componente_recusado',
    ],
    [
      'o parâmetro nomeado no formato posicional',
      { components: [{ type: 'BODY', text: 'Oi {{nome}}' }] },
      { 'body.nome': 'contato.nome' },
      'parametro_invalido',
    ],
    [
      'o parâmetro posicional no formato nomeado',
      { parameterFormat: 'NAMED', components: [{ type: 'BODY', text: 'Oi {{1}}' }] },
      { 'body.1': 'contato.nome' },
      'parametro_invalido',
    ],
    [
      'o parâmetro sem fechar',
      { components: [{ type: 'BODY', text: 'Oi {{1}} e {{2' }] },
      { 'body.1': 'contato.nome' },
      'parametro_invalido',
    ],
    ['o parâmetro sem vínculo', {}, { 'body.1': 'contato.nome' }, 'vinculo_incompleto'],
    ['o vínculo sem parâmetro', {}, { ...VINCULOS, 'body.2': 'contato.nome' }, 'vinculo_sobrando'],
    [
      'o vínculo a campo fora do catálogo do Core',
      {},
      { 'body.1': 'contato.nome', 'header.1': 'contato.cpf' },
      'campo_fora_do_catalogo',
    ],
    [
      'a chave desconhecida num componente aceito (falha fechada)',
      { components: [{ type: 'BODY', text: 'Ola {{1}}', add_security_recommendation: true }] },
      { 'body.1': 'contato.nome' },
      'componente_recusado',
    ],
    [
      'a chave desconhecida num botão aceito',
      {
        components: [
          LEMBRETE.components[1],
          {
            type: 'BUTTONS',
            buttons: [
              { type: 'URL', text: 'Abrir', url: 'https://exemplo.test', app_deep_link: { x: 1 } },
            ],
          },
        ],
      },
      { 'body.1': 'contato.nome' },
      'componente_recusado',
    ],
    [
      'o componente repetido',
      { components: [LEMBRETE.components[1], { type: 'BODY', text: 'Outro {{1}}' }] },
      { 'body.1': 'contato.nome' },
      'componente_recusado',
    ],
    [
      'a categoria que pegaria a herança do objeto',
      { category: 'constructor' },
      VINCULOS,
      'categoria_recusada',
    ],
    [
      'o formato que pegaria a herança do objeto',
      { parameterFormat: '__proto__' },
      VINCULOS,
      'formato_recusado',
    ],
  ])('recusa %s', (_nome, mudanca, vinculos, motivo) => {
    expect(canonizar({ ...LEMBRETE, ...mudanca } as typeof LEMBRETE, vinculos)).toEqual({
      ok: false,
      motivo,
    });
  });
});
