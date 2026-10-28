import type { TemplateComponentDto } from '@veyra/contracts';
import {
  componentesDoEnvio,
  textoDaPrevia,
  valorAceito,
  valoresDosParametros,
} from './envio-do-template';

/**
 * A montagem do envio (F4.1c-3): os valores pelos vínculos, o texto da prévia
 * e os componentes à Meta. Conteúdo FICTÍCIO.
 */
describe('a montagem do envio de uma versão de template', () => {
  const componentes: TemplateComponentDto[] = [
    { type: 'header', format: 'text', text: 'Olá, {{1}}' },
    { type: 'body', text: 'Oi {{1}}, sua consulta é amanhã. {{2}} {{10}}' },
    { type: 'footer', text: 'Clinica Ficticia' },
    { type: 'buttons', buttons: [{ type: 'quick_reply', text: 'Confirmar' }] },
  ];

  it('os valores saem dos vínculos e dos campos; o campo que falta não é completado', () => {
    expect(
      valoresDosParametros({ 'body.1': 'contato.nome' }, { 'contato.nome': 'Ana Ficticia' }),
    ).toEqual({ 'body.1': 'Ana Ficticia' });
    expect(valoresDosParametros({ 'body.1': 'contato.nome' }, {})).toBeNull();
    // um campo herdado não conta como campo
    expect(valoresDosParametros({ 'body.1': 'constructor' }, {})).toBeNull();
  });

  it('o valor vazio, longo, com quebra de linha, tabulação ou cinco espaços não serve', () => {
    expect(valorAceito('Ana')).toBe(true);
    for (const ruim of ['', '   ', 'a'.repeat(201), 'Ana\nBeto', 'Ana\tBeto', 'Ana     Beto', 7]) {
      expect(valorAceito(ruim)).toBe(false);
    }
    expect(valorAceito('a'.repeat(200))).toBe(true);
    expect(valoresDosParametros({ 'body.1': 'contato.nome' }, { 'contato.nome': 'Ana\nB' })).toBe(
      null,
    );
  });

  it('o texto da prévia: cabeçalho, corpo e rodapé, com os valores no lugar; sem os botões', () => {
    expect(
      textoDaPrevia(componentes, {
        'header.1': 'Ana',
        'body.1': 'Ana',
        'body.2': 'dois',
        'body.10': 'dez',
      }),
    ).toBe('Olá, Ana\n\nOi Ana, sua consulta é amanhã. dois dez\n\nClinica Ficticia');
  });

  it('no posicional, a ordem do envio é a NUMÉRICA: o {{2}} antes do {{10}}', () => {
    const envio = componentesDoEnvio(
      [{ type: 'body', text: '{{10}} e {{2}} e {{1}} e {{2}}' }],
      'positional',
      { 'body.1': 'um', 'body.2': 'dois', 'body.10': 'dez' },
    );
    expect(envio).toEqual({
      header: [],
      body: [{ text: 'um' }, { text: 'dois' }, { text: 'dez' }],
    });
  });

  it('o cabeçalho também leva os parâmetros dele; no nomeado, com o nome', () => {
    expect(
      componentesDoEnvio(
        [
          { type: 'header', format: 'text', text: 'Olá, {{nome}}' },
          { type: 'body', text: '{{nome}}, até {{dia}}.' },
        ],
        'named',
        { 'header.nome': 'Ana', 'body.nome': 'Ana', 'body.dia': 'amanhã' },
      ),
    ).toEqual({
      header: [{ text: 'Ana', name: 'nome' }],
      body: [
        { text: 'Ana', name: 'nome' },
        { text: 'amanhã', name: 'dia' },
      ],
    });
  });

  it('faltou o valor de um parâmetro: nada é montado', () => {
    expect(componentesDoEnvio(componentes, 'positional', { 'body.1': 'Ana' })).toBeNull();
  });
});
