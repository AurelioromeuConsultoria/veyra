import type { ClsService } from 'nestjs-cls';
import {
  OutboundPreconditionService,
  partesDaOrigem,
  type LeitorDaPreCondicao,
  type OutboundPreconditionAnswer,
  type OutboundPreconditionProvider,
} from './outbound-precondition';

/**
 * A fachada do E7 (F4.1c-3): o roteamento por prefixo e a falha fechada. Os
 * ids são FICTÍCIOS.
 */
describe('a pré-condição do envio do negócio (E7)', () => {
  const WS = '00000000-0000-4000-8000-000000000001';
  const PEDIDO = '00000000-0000-4000-8000-0000000000aa';
  const CONTATO = '00000000-0000-4000-8000-0000000000bb';
  // o contexto do pedido: o workspace explícito de cada consulta
  const cls = { get: () => WS } as unknown as ClsService;
  const LIMITE = new Date('2030-11-04T10:00:00.000Z');
  // o cliente de quem chama: a porta recebe exatamente este
  const LEITOR = {} as LeitorDaPreCondicao;
  const porta = (
    prefix: string,
    check: (ws: string, id: string) => Promise<OutboundPreconditionAnswer>,
    requiredPermissions: readonly string[] = ['teste:pedido:aprovar'],
    fields: readonly string[] = [],
    purposeKeys: readonly string[] = [],
  ): OutboundPreconditionProvider => ({
    prefix,
    check: (leitor, ws, id) => {
      // a porta lê pelo leitor de quem chama, e não por um cliente próprio
      if (leitor !== LEITOR) throw new Error('a porta não recebeu o leitor de quem chama');
      return check(ws, id);
    },
    requiredPermissions,
    fields,
    purposeKeys,
  });

  it('a origem do Core não consulta porta; o prefixo sem porta e a origem malformada são desconhecidos', async () => {
    const consultadas: string[] = [];
    const servico = new OutboundPreconditionService(
      [
        porta('teste.pedido', async (_, id) => {
          consultadas.push(id);
          return { valid: false };
        }),
      ],
      cls,
    );
    expect(await servico.consultar(LEITOR, WS, `conversation:${PEDIDO}`)).toEqual({ tipo: 'core' });
    expect(await servico.consultar(LEITOR, WS, `outro.pedido:${PEDIDO}`)).toEqual({
      tipo: 'desconhecida',
    });
    expect(await servico.consultar(LEITOR, WS, 'teste.pedido:nao-e-uuid')).toEqual({
      tipo: 'desconhecida',
    });
    expect(consultadas).toEqual([]);
  });

  it('vale: os valores e as chaves, em ordem e sem repetição, com o id do pedido e o workspace explícito', async () => {
    const vistos: [string, string][] = [];
    const servico = new OutboundPreconditionService(
      [
        porta(
          'teste.pedido',
          async (ws, id) => {
            vistos.push([ws, id]);
            return {
              valid: true,
              contactId: CONTATO,
              values: { 'teste.horario': '10h' },
              validityKeys: [`teste.b:${PEDIDO}`, `teste.a:${PEDIDO}`, `teste.a:${PEDIDO}`],
              expiresAt: LIMITE,
            };
          },
          ['teste:pedido:aprovar'],
          ['teste.horario'],
        ),
      ],
      cls,
    );
    expect(await servico.consultar(LEITOR, WS, `teste.pedido:${PEDIDO}`)).toEqual({
      tipo: 'vale',
      contactId: CONTATO,
      valores: { 'teste.horario': '10h' },
      chaves: [`teste.a:${PEDIDO}`, `teste.b:${PEDIDO}`],
      limite: LIMITE,
    });
    expect(vistos).toEqual([[WS, PEDIDO]]);
  });

  it('não vale é não vale; erro, prazo e resposta fora do contrato são indisponíveis', async () => {
    const com = (check: () => Promise<OutboundPreconditionAnswer>) =>
      new OutboundPreconditionService([porta('teste.pedido', check)], cls).consultar(
        LEITOR,
        WS,
        `teste.pedido:${PEDIDO}`,
      );
    expect(await com(async () => ({ valid: false }))).toEqual({ tipo: 'nao_vale' });
    expect(
      await com(async () => {
        throw new Error('caiu');
      }),
    ).toEqual({ tipo: 'indisponivel' });
    for (const fora of [
      null,
      { valid: 'sim' },
      { valid: true, contactId: CONTATO, values: ['10h'], validityKeys: [], expiresAt: LIMITE },
      // o pedido sem o contato a quem se destina, ou com um que não é id
      { valid: true, values: {}, validityKeys: [], expiresAt: LIMITE },
      { valid: true, contactId: 'Ana', values: {}, validityKeys: [], expiresAt: LIMITE },
      {
        valid: true,
        contactId: CONTATO,
        values: { 'pedido.horario': 10 },
        validityKeys: [],
        expiresAt: LIMITE,
      },
      {
        valid: true,
        contactId: CONTATO,
        values: {},
        validityKeys: ['sem-formato'],
        expiresAt: LIMITE,
      },
      {
        valid: true,
        contactId: CONTATO,
        values: {},
        validityKeys: Array.from({ length: 11 }, () => `a:${PEDIDO}`),
        expiresAt: LIMITE,
      },
      // o limite do prazo ausente ou inválido
      { valid: true, contactId: CONTATO, values: {}, validityKeys: [] },
      { valid: true, contactId: CONTATO, values: {}, validityKeys: [], expiresAt: '2030-11-04' },
      { valid: true, contactId: CONTATO, values: {}, validityKeys: [], expiresAt: new Date('x') },
    ]) {
      expect(await com(async () => fora as never)).toEqual({ tipo: 'indisponivel' });
    }
  });

  it('a porta que não responde no prazo é indisponível', async () => {
    jest.useFakeTimers();
    try {
      const servico = new OutboundPreconditionService(
        [porta('teste.pedido', () => new Promise(() => undefined))],
        cls,
      );
      const consulta = servico.consultar(LEITOR, WS, `teste.pedido:${PEDIDO}`);
      await jest.advanceTimersByTimeAsync(3_000);
      expect(await consulta).toEqual({ tipo: 'indisponivel' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('o prazo da porta é de 2 s: pendente em 1999 ms, indisponível em 2000 ms', async () => {
    jest.useFakeTimers();
    try {
      const servico = new OutboundPreconditionService(
        [porta('teste.pedido', () => new Promise(() => undefined))],
        cls,
      );
      let veredito: unknown = null;
      void servico.consultar(LEITOR, WS, `teste.pedido:${PEDIDO}`).then((v) => (veredito = v));
      await jest.advanceTimersByTimeAsync(1_999);
      expect(veredito).toBeNull();
      await jest.advanceTimersByTimeAsync(1);
      expect(veredito).toEqual({ tipo: 'indisponivel' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('fora do contexto do workspace explícito, nada é consultado: indisponível', async () => {
    const consultadas: string[] = [];
    const servico = new OutboundPreconditionService(
      [
        porta('teste.pedido', async (_, id) => {
          consultadas.push(id);
          return { valid: false };
        }),
      ],
      { get: () => '00000000-0000-4000-8000-0000000000ff' } as unknown as ClsService,
    );
    expect(await servico.consultar(LEITOR, WS, `teste.pedido:${PEDIDO}`)).toEqual({
      tipo: 'indisponivel',
    });
    expect(consultadas).toEqual([]);
  });

  it('o boot recusa o prefixo repetido, o inválido e o do Core', () => {
    const nada = async () => ({ valid: false }) as const;
    expect(
      () => new OutboundPreconditionService([porta('a.b', nada), porta('a.b', nada)], cls),
    ).toThrow(/repetido/);
    expect(() => new OutboundPreconditionService([porta('A b', nada)], cls)).toThrow(/inválido/);
    // a porta sem permissão própria, ou com uma fora do formato
    expect(() => new OutboundPreconditionService([porta('a.b', nada, [])], cls)).toThrow(
      /Permissões/,
    );
    expect(() => new OutboundPreconditionService([porta('a.b', nada, ['Livre'])], cls)).toThrow(
      /Permissões/,
    );
    expect(() => new OutboundPreconditionService([porta('conversation', nada)], cls)).toThrow(
      /inválido/,
    );
  });

  it('as finalidades da porta (F4.2): da extensão, de uma porta só, e só valem pela origem dela', () => {
    const nada = async () => ({ valid: false }) as const;
    const comFinalidades = (prefix: string, purposeKeys: string[]) =>
      porta(prefix, nada, ['teste:pedido:aprovar'], [], purposeKeys);
    for (const chaves of [['outra_x'], ['teste'], ['Teste_x'], ['teste_a', 'teste_a']]) {
      expect(
        () => new OutboundPreconditionService([comFinalidades('teste.pedido', chaves)], cls),
      ).toThrow(/Finalidades/);
    }
    expect(
      () =>
        new OutboundPreconditionService(
          [comFinalidades('teste.pedido', ['teste_a']), comFinalidades('teste.outro', ['teste_a'])],
          cls,
        ),
    ).toThrow(/Finalidades/);
    const servico = new OutboundPreconditionService(
      [comFinalidades('teste.pedido', ['teste_reservada'])],
      cls,
    );
    expect(servico.finalidadesDasPortas()).toEqual(['teste_reservada']);
    // a do vertical, só pela origem dele: nunca pelo Inbox nem por outra porta
    expect(servico.finalidadeDaOrigem('teste_reservada', `teste.pedido:${PEDIDO}`)).toBe(true);
    expect(servico.finalidadeDaOrigem('teste_reservada', `conversation:${PEDIDO}`)).toBe(false);
    expect(servico.finalidadeDaOrigem('teste_reservada', `teste.outro:${PEDIDO}`)).toBe(false);
    // a que nenhuma porta declara, por qualquer origem
    expect(servico.finalidadeDaOrigem('lembrete', `conversation:${PEDIDO}`)).toBe(true);
    expect(servico.finalidadeDaOrigem('lembrete', `teste.pedido:${PEDIDO}`)).toBe(true);
  });

  it('os campos da porta (F4.2): da extensão do prefixo, sem repetir; e a resposta só traz os declarados', async () => {
    const nada = async () => ({ valid: false }) as const;
    const comCampos = (prefix: string, fields: string[]) =>
      porta(prefix, nada, ['teste:pedido:aprovar'], fields);
    // de outra extensão, do Core, fora do formato e repetido entre portas
    for (const fields of [['outra.data'], ['contato.nome'], ['teste'], ['teste.a', 'teste.a']]) {
      expect(
        () => new OutboundPreconditionService([comCampos('teste.pedido', fields)], cls),
      ).toThrow(/Campos/);
    }
    expect(
      () =>
        new OutboundPreconditionService(
          [comCampos('teste.pedido', ['teste.data']), comCampos('teste.outro', ['teste.data'])],
          cls,
        ),
    ).toThrow(/Campos/);
    const servico = new OutboundPreconditionService(
      [
        porta(
          'teste.pedido',
          async () => ({
            valid: true,
            contactId: CONTATO,
            values: { 'teste.data': '04/11/2030', 'teste.extra': 'x' },
            validityKeys: [],
            expiresAt: LIMITE,
          }),
          ['teste:pedido:aprovar'],
          ['teste.data'],
        ),
      ],
      cls,
    );
    expect(servico.camposDasPortas()).toEqual(['teste.data']);
    // a extensão `contato` é do Core: a porta dela não declara `contato.nome`
    // nem um campo `contato.*` que o Core ainda não tem
    for (const campo of ['contato.nome', 'contato.sobrenome']) {
      expect(() => new OutboundPreconditionService([comCampos('contato.x', [campo])], cls)).toThrow(
        /Campos/,
      );
    }
    // um valor de campo não declarado: fora do contrato
    expect(await servico.consultar(LEITOR, WS, `teste.pedido:${PEDIDO}`)).toEqual({
      tipo: 'indisponivel',
    });
  });

  it('as permissões da origem vêm da porta registrada: a do Core não exige nenhuma; a sem porta, recusa', () => {
    const servico = new OutboundPreconditionService(
      [
        porta('teste.pedido', async () => ({ valid: false }), [
          'teste:pedido:ler',
          'teste:pedido:aprovar',
        ]),
      ],
      cls,
    );
    expect(servico.permissoesDaOrigem(`teste.pedido:${PEDIDO}`)).toEqual([
      'teste:pedido:ler',
      'teste:pedido:aprovar',
    ]);
    expect(servico.permissoesDaOrigem(`conversation:${PEDIDO}`)).toEqual([]);
    expect(servico.permissoesDaOrigem(`outro.pedido:${PEDIDO}`)).toBeNull();
    expect(servico.permissoesDaOrigem('malformada')).toBeNull();
  });

  it('as partes da origem', () => {
    expect(partesDaOrigem(`conversation:${PEDIDO}`)).toEqual({
      prefixo: 'conversation',
      id: PEDIDO,
    });
    expect(partesDaOrigem(PEDIDO)).toBeNull();
    expect(partesDaOrigem(`:${PEDIDO}`)).toBeNull();
  });
});
