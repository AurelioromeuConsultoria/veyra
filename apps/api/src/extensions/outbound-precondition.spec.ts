import type { ClsService } from 'nestjs-cls';
import {
  OutboundPreconditionService,
  partesDaOrigem,
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
  const porta = (
    prefix: string,
    check: (ws: string, id: string) => Promise<OutboundPreconditionAnswer>,
  ): OutboundPreconditionProvider => ({ prefix, check });

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
    expect(await servico.consultar(WS, `conversation:${PEDIDO}`)).toEqual({ tipo: 'core' });
    expect(await servico.consultar(WS, `outro.pedido:${PEDIDO}`)).toEqual({ tipo: 'desconhecida' });
    expect(await servico.consultar(WS, 'teste.pedido:nao-e-uuid')).toEqual({
      tipo: 'desconhecida',
    });
    expect(consultadas).toEqual([]);
  });

  it('vale: os valores e as chaves, em ordem e sem repetição, com o id do pedido e o workspace explícito', async () => {
    const vistos: [string, string][] = [];
    const servico = new OutboundPreconditionService(
      [
        porta('teste.pedido', async (ws, id) => {
          vistos.push([ws, id]);
          return {
            valid: true,
            contactId: CONTATO,
            values: { 'pedido.horario': '10h' },
            validityKeys: [`teste.b:${PEDIDO}`, `teste.a:${PEDIDO}`, `teste.a:${PEDIDO}`],
          };
        }),
      ],
      cls,
    );
    expect(await servico.consultar(WS, `teste.pedido:${PEDIDO}`)).toEqual({
      tipo: 'vale',
      contactId: CONTATO,
      valores: { 'pedido.horario': '10h' },
      chaves: [`teste.a:${PEDIDO}`, `teste.b:${PEDIDO}`],
    });
    expect(vistos).toEqual([[WS, PEDIDO]]);
  });

  it('não vale é não vale; erro, prazo e resposta fora do contrato são indisponíveis', async () => {
    const com = (check: () => Promise<OutboundPreconditionAnswer>) =>
      new OutboundPreconditionService([porta('teste.pedido', check)], cls).consultar(
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
      { valid: true, contactId: CONTATO, values: ['10h'], validityKeys: [] },
      // o pedido sem o contato a quem se destina, ou com um que não é id
      { valid: true, values: {}, validityKeys: [] },
      { valid: true, contactId: 'Ana', values: {}, validityKeys: [] },
      { valid: true, contactId: CONTATO, values: { 'pedido.horario': 10 }, validityKeys: [] },
      { valid: true, contactId: CONTATO, values: {}, validityKeys: ['sem-formato'] },
      {
        valid: true,
        contactId: CONTATO,
        values: {},
        validityKeys: Array.from({ length: 11 }, () => `a:${PEDIDO}`),
      },
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
      const consulta = servico.consultar(WS, `teste.pedido:${PEDIDO}`);
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
      void servico.consultar(WS, `teste.pedido:${PEDIDO}`).then((v) => (veredito = v));
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
    expect(await servico.consultar(WS, `teste.pedido:${PEDIDO}`)).toEqual({ tipo: 'indisponivel' });
    expect(consultadas).toEqual([]);
  });

  it('o boot recusa o prefixo repetido, o inválido e o do Core', () => {
    const nada = async () => ({ valid: false }) as const;
    expect(
      () => new OutboundPreconditionService([porta('a.b', nada), porta('a.b', nada)], cls),
    ).toThrow(/repetido/);
    expect(() => new OutboundPreconditionService([porta('A b', nada)], cls)).toThrow(/inválido/);
    expect(() => new OutboundPreconditionService([porta('conversation', nada)], cls)).toThrow(
      /inválido/,
    );
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
