import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AuthUserDto, ConversationDto } from '@veyra/contracts';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { ExperienceProvider } from '../../lib/experience';
import { ME_KEY } from '../../lib/session';
import { ContextoDaConversa } from '../../pages/InboxContexto';
import { clinicsExperience } from './experience';
import { rotuloDoHorario } from './SugestaoDeRemarcacao';

/**
 * A sugestão "Remarcar" sem IA no contexto clínico da conversa (ADR-062
 * adendo 1, parte B). Dados FICTÍCIOS. O que se prova, pelo painel do CORE
 * com o manifesto da clínica:
 *
 * - só aparece para quem escreve na agenda, e só com agendamento futuro
 *   marcado ou confirmado; sem isso, nem a consulta das opções sai;
 * - o rótulo é "Sugestão", sem o selo de IA;
 * - o clique pede confirmação e remarca pela rota da Agenda, com o horário
 *   como veio do servidor, e recarrega a agenda;
 * - o horário tomado no meio do caminho (409) aparece com mensagem clara, os
 *   botões ficam desabilitados até as opções novas chegarem e só então a
 *   mensagem diz que foram atualizadas;
 * - o resultado (o "Remarcado: …" ou o 409 de estado) fica na tela, com o
 *   agendamento fixado, mesmo que a agenda recarregada troque o próximo
 *   remarcável, até o usuário dispensar;
 * - a carga e o erro das opções.
 */

const CONVERSA = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e61';
const CONTATO = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e62';
const PACIENTE = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e63';

const conversa = (): ConversationDto => ({
  id: CONVERSA,
  channelType: 'whatsapp',
  contactId: CONTATO,
  contactName: 'Pessoa Fictícia',
  senderStatus: 'identified',
  senderAddress: '+5511987654321',
  senderIdentifiedByPerson: false,
  senderRelinkBlocked: false,
  subject: null,
  status: 'open',
  assigneeMembershipId: null,
  assigneeName: null,
  lastMessageAt: '2030-11-04T12:00:00.000Z',
  windowExpiresAt: null,
  createdAt: '2030-11-04T11:00:00.000Z',
});

const usuario = (permissions: string[]) =>
  ({
    id: 'u1',
    name: 'Pessoa da Clínica',
    email: 'pessoa@clinica.test',
    activeMembership: {
      membershipId: 'm1',
      workspaceId: 'w1',
      workspaceName: 'Clínica',
      workspaceSlug: 'clinica',
      roleName: 'Member',
      roleSystemKey: 'member',
      status: 'active',
    },
    permissions,
    memberships: [],
    experience: { key: 'clinics', status: 'ready' },
  }) as unknown as AuthUserDto;

const LE = ['conversations:read', 'contacts:read', 'clinics:schedule:read'];
const ESCREVE = [...LE, 'clinics:schedule:write'];

const daqui = (minutos: number) => new Date(Date.now() + minutos * 60_000).toISOString();
const horario = (
  id: string,
  startsAt: string,
  status: string,
  serviceName = 'Limpeza de pele',
) => ({
  id,
  patientId: PACIENTE,
  patientName: 'Pessoa Fictícia',
  professionalId: 'pr1',
  professionalName: 'Dra. Ana Fictícia',
  serviceId: 'sv1',
  serviceName,
  unitId: 'un1',
  startsAt,
  endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
  localDate: '2030-11-06',
  localStart: '10:00',
  localEnd: '11:00',
  status,
  cancelReason: null,
});

const opcao = (localDate: string, localStart: string, startsAt: string) => ({
  startsAt,
  endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
  localDate,
  localStart,
  localEnd: '',
});
const OPCOES = [
  opcao('2030-11-04', '11:00', '2030-11-04T14:00:00.000Z'),
  opcao('2030-11-04', '11:15', '2030-11-04T14:15:00.000Z'),
  opcao('2030-11-05', '08:00', '2030-11-05T11:00:00.000Z'),
];
const opcoesDto = (options: unknown[]) => ({
  appointmentId: 'h-proximo',
  professionalId: 'pr1',
  unitId: 'un1',
  timezone: 'America/Sao_Paulo',
  durationMin: 60,
  options,
});

type Resposta = { status?: number; body?: unknown };
type Chamada = { metodo: string; url: string; corpo: unknown };
type Rota = (c: Chamada) => Resposta | undefined | Promise<Resposta | undefined>;

/** O fetch falso: a primeira rota que responder ganha; registra método, url e corpo. */
function mockApi(rota: Rota) {
  const chamadas: Chamada[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const metodo = (init?.method ?? 'GET').toUpperCase();
      const corpo = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      const c = { metodo, url, corpo };
      chamadas.push(c);
      const r = (await rota(c)) ?? {
        status: 404,
        body: { message: `sem mock: ${metodo} ${url}` },
      };
      return new Response(JSON.stringify(r.body ?? {}), {
        status: r.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return chamadas;
}

/** A clínica: o paciente, os horários dados e as rotas da sugestão (`extra` decide antes). */
const clinica =
  (horarios: unknown[], extra: Rota = () => undefined): Rota =>
  (c) => {
    const r = extra(c);
    if (r) return r;
    if (c.url.startsWith('/api/clinics/status')) return { body: { active: true } };
    if (c.url.startsWith(`/api/clinics/patients?contactIds=${CONTATO}`)) {
      return { body: [{ id: PACIENTE, contactId: CONTATO, name: 'Pessoa Fictícia' }] };
    }
    if (c.url.includes('/reschedule-options')) return { body: opcoesDto(OPCOES) };
    if (c.url.startsWith('/api/clinics/appointments')) return { body: horarios };
    if (c.url.startsWith('/api/clinics/returns')) return { body: [] };
    return undefined;
  };

function renderizar(permissions: string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(ME_KEY, usuario(permissions));
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ExperienceProvider value={clinicsExperience}>
          <ContextoDaConversa conversa={conversa()} janelaExpiraEm={null} />
        </ExperienceProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return screen.getByRole('complementary', { name: 'Contexto da conversa' });
}

const assentar = () => new Promise((r) => setTimeout(r, 60));

/** Uma resposta presa até o teste soltar. */
function adiado() {
  let soltar!: (r: Resposta) => void;
  const promessa = new Promise<Resposta>((r) => {
    soltar = r;
  });
  return { promessa, soltar };
}
const pedidosDeOpcoes = (chamadas: Chamada[]) =>
  chamadas.filter((c) => c.url.includes('/reschedule-options'));

/** um em curso (chegou), um cancelado, o próximo confirmado e um depois */
const HORARIOS = [
  horario('h-em-curso', daqui(-10), 'arrived'),
  horario('h-cancelado', daqui(60), 'canceled'),
  horario('h-depois', daqui(9 * 1440), 'scheduled'),
  horario('h-proximo', daqui(2 * 1440), 'confirmed'),
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Sugestão de remarcação sem IA (contexto clínico da conversa)', () => {
  it('rótulo local do horário: dia da semana, data e hora; o deslocamento só na hora repetida', () => {
    expect(rotuloDoHorario('2030-11-04', '11:00')).toBe('Seg, 04/11 · 11:00');
    expect(rotuloDoHorario('2030-11-03', '01:15', '-05:00')).toBe('Dom, 03/11 · 01:15 (-05:00)');
  });

  it('só quem escreve na agenda: quem só lê não vê a sugestão nem pede as opções', async () => {
    const chamadas = mockApi(clinica(HORARIOS));
    const painel = renderizar(LE);
    const clinico = await within(painel).findByRole('region', { name: 'Contexto clínico' });
    // o próximo horário é o em curso: a agenda já chegou
    await within(clinico).findByText('Chegou');
    await assentar();
    expect(within(clinico).queryByRole('group', { name: 'Sugestão' })).toBeNull();
    expect(pedidosDeOpcoes(chamadas)).toEqual([]);
  });

  it('com a escrita: o próximo remarcável (não o em curso nem o cancelado), as opções do servidor e nada de IA', async () => {
    const chamadas = mockApi(clinica(HORARIOS));
    const painel = renderizar(ESCREVE);
    const sugestao = await within(painel).findByRole('group', { name: 'Sugestão' });
    expect(sugestao).toHaveTextContent('Remarcar Limpeza de pele de Qua, 06/11 · 10:00 para:');
    const botoes = await within(sugestao).findAllByRole('button');
    expect(botoes.map((b) => b.textContent)).toEqual([
      'Seg, 04/11 · 11:00',
      'Seg, 04/11 · 11:15',
      'Ter, 05/11 · 08:00',
    ]);
    // o pedido é do agendamento confirmado, com 3 opções
    expect(pedidosDeOpcoes(chamadas).map((c) => c.url)).toEqual([
      '/api/clinics/appointments/h-proximo/reschedule-options?limit=3',
    ]);
    // "Sugestão", sem selo nem texto de IA
    expect(painel).not.toHaveTextContent(/\bIA\b/);
  });

  it('o clique pede confirmação; confirmar remarca com o horário como veio e recarrega a agenda', async () => {
    const chamadas = mockApi(
      clinica(HORARIOS, (c) =>
        c.metodo === 'POST' && c.url === '/api/clinics/appointments/h-proximo/reschedule'
          ? {
              status: 201,
              body: { ...horario('h-proximo', OPCOES[1].startsAt, 'scheduled'), ...OPCOES[1] },
            }
          : undefined,
      ),
    );
    const painel = renderizar(ESCREVE);
    const sugestao = await within(painel).findByRole('group', { name: 'Sugestão' });
    fireEvent.click(await within(sugestao).findByRole('button', { name: /11:15/ }));
    // nada sai antes da confirmação
    expect(chamadas.some((c) => c.metodo === 'POST')).toBe(false);
    expect(sugestao).toHaveTextContent('Confirmar a remarcação para Seg, 04/11 · 11:15?');
    const agendaAntes = chamadas.filter((c) => c.url.startsWith('/api/clinics/appointments?'));
    fireEvent.click(within(sugestao).getByRole('button', { name: 'Confirmar remarcação' }));
    expect(await within(sugestao).findByRole('status')).toHaveTextContent(
      'Remarcado: Limpeza de pele para Seg, 04/11 · 11:15, com Dra. Ana Fictícia.',
    );
    const posts = chamadas.filter((c) => c.metodo === 'POST');
    expect(posts).toEqual([
      {
        metodo: 'POST',
        url: '/api/clinics/appointments/h-proximo/reschedule',
        corpo: { date: '2030-11-04', time: '11:15' },
      },
    ]);
    // a agenda do paciente foi pedida de novo
    await waitFor(() =>
      expect(
        chamadas.filter((c) => c.url.startsWith('/api/clinics/appointments?')).length,
      ).toBeGreaterThan(agendaAntes.length),
    );
  });

  it('a hora repetida da mudança de horário vai com o deslocamento', async () => {
    const repetida = {
      ...opcao('2030-11-03', '01:15', '2030-11-03T06:15:00.000Z'),
      utcOffset: '-05:00',
    };
    const chamadas = mockApi(
      clinica(HORARIOS, (c) =>
        c.url.includes('/reschedule-options')
          ? { body: opcoesDto([repetida]) }
          : c.metodo === 'POST'
            ? {
                status: 201,
                body: { ...horario('h-proximo', repetida.startsAt, 'scheduled'), ...repetida },
              }
            : undefined,
      ),
    );
    const painel = renderizar(ESCREVE);
    const sugestao = await within(painel).findByRole('group', { name: 'Sugestão' });
    fireEvent.click(
      await within(sugestao).findByRole('button', { name: 'Dom, 03/11 · 01:15 (-05:00)' }),
    );
    fireEvent.click(within(sugestao).getByRole('button', { name: 'Confirmar remarcação' }));
    await within(sugestao).findByRole('status');
    expect(chamadas.find((c) => c.metodo === 'POST')?.corpo).toEqual({
      date: '2030-11-03',
      time: '01:15',
      utcOffset: '-05:00',
    });
  });

  it('o horário tomado no meio do caminho: botões desabilitados até as opções novas chegarem, e só então "atualizadas"', async () => {
    let pedidos = 0;
    const recarga = adiado();
    const chamadas = mockApi(
      clinica(HORARIOS, (c) => {
        if (c.url.includes('/reschedule-options')) {
          pedidos += 1;
          // a primeira lista vem na hora; a recarga depois do conflito fica
          // presa, e a primeira opção já não vem nela
          return pedidos === 1 ? { body: opcoesDto(OPCOES) } : recarga.promessa;
        }
        if (c.metodo === 'POST') {
          return { status: 409, body: { message: 'Horário já ocupado para este profissional' } };
        }
        return undefined;
      }),
    );
    const painel = renderizar(ESCREVE);
    const sugestao = await within(painel).findByRole('group', { name: 'Sugestão' });
    fireEvent.click(await within(sugestao).findByRole('button', { name: /11:00/ }));
    fireEvent.click(within(sugestao).getByRole('button', { name: 'Confirmar remarcação' }));
    const alerta = await within(sugestao).findByRole('alert');
    await waitFor(() => expect(pedidosDeOpcoes(chamadas).length).toBe(2));
    // enquanto a recarga não volta: as opções antigas, desabilitadas, e nada
    // de "atualizadas"
    expect(alerta).toHaveTextContent('Esse horário acabou de ser ocupado. Atualizando as opções…');
    expect(alerta).not.toHaveTextContent('atualizadas');
    const antigas = within(sugestao).getAllByRole('button');
    expect(antigas.map((b) => b.textContent)).toEqual([
      'Seg, 04/11 · 11:00',
      'Seg, 04/11 · 11:15',
      'Ter, 05/11 · 08:00',
    ]);
    expect(antigas.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    fireEvent.click(antigas[0]);
    expect(within(sugestao).queryByRole('button', { name: 'Confirmar remarcação' })).toBeNull();

    recarga.soltar({ body: opcoesDto(OPCOES.slice(1)) });
    await waitFor(() =>
      expect(within(sugestao).getByRole('alert')).toHaveTextContent(
        'Esse horário acabou de ser ocupado. As opções foram atualizadas: escolha outra.',
      ),
    );
    expect(within(sugestao).queryByRole('button', { name: /11:00/ })).toBeNull();
    const novas = within(sugestao).getAllByRole('button');
    expect(novas.map((b) => b.textContent)).toEqual(['Seg, 04/11 · 11:15', 'Ter, 05/11 · 08:00']);
    expect(novas.every((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
    expect(within(sugestao).queryByRole('status')).toBeNull();
  });

  it('o "Remarcado: …" fica na tela quando a agenda recarregada troca o próximo remarcável, até dispensar', async () => {
    // o remarcado vai para DEPOIS de outro: na agenda nova, o próximo
    // remarcável passa a ser o outro
    const depois = horario('h-depois', daqui(9 * 1440), 'scheduled', 'Peeling');
    let remarcado = false;
    const chamadas = mockApi(
      clinica([], (c) => {
        if (c.metodo === 'POST' && c.url === '/api/clinics/appointments/h-proximo/reschedule') {
          remarcado = true;
          return {
            status: 201,
            body: { ...horario('h-proximo', OPCOES[2].startsAt, 'scheduled'), ...OPCOES[2] },
          };
        }
        if (c.url.startsWith('/api/clinics/appointments?')) {
          const proximo = remarcado
            ? horario('h-proximo', daqui(12 * 1440), 'scheduled')
            : horario('h-proximo', daqui(2 * 1440), 'confirmed');
          return { body: [proximo, depois] };
        }
        return undefined;
      }),
    );
    const painel = renderizar(ESCREVE);
    const sugestao = await within(painel).findByRole('group', { name: 'Sugestão' });
    expect(sugestao).toHaveTextContent('Remarcar Limpeza de pele de');
    fireEvent.click(await within(sugestao).findByRole('button', { name: /08:00/ }));
    const agendaAntes = chamadas.filter((c) => c.url.startsWith('/api/clinics/appointments?'));
    fireEvent.click(within(sugestao).getByRole('button', { name: 'Confirmar remarcação' }));
    await within(painel).findByText(/^Remarcado:/);
    // a agenda voltou com o outro na frente, e o resultado continua
    await waitFor(() =>
      expect(
        chamadas.filter((c) => c.url.startsWith('/api/clinics/appointments?')).length,
      ).toBeGreaterThan(agendaAntes.length),
    );
    await assentar();
    const fixada = within(painel).getByRole('group', { name: 'Sugestão' });
    expect(within(fixada).getByRole('status')).toHaveTextContent(
      'Remarcado: Limpeza de pele para Ter, 05/11 · 08:00, com Dra. Ana Fictícia.',
    );
    // nada de opções por trás do resultado
    expect(
      within(fixada)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Dispensar']);
    const pedidosAntes = pedidosDeOpcoes(chamadas).length;
    fireEvent.click(within(fixada).getByRole('button', { name: 'Dispensar' }));
    // dispensado: o cartão volta à agenda atual, com o outro agendamento
    await waitFor(() =>
      expect(within(painel).getByRole('group', { name: 'Sugestão' })).toHaveTextContent(
        'Remarcar Peeling de',
      ),
    );
    await waitFor(() => expect(pedidosDeOpcoes(chamadas).length).toBeGreaterThan(pedidosAntes));
    expect(pedidosDeOpcoes(chamadas).at(-1)?.url).toBe(
      '/api/clinics/appointments/h-depois/reschedule-options?limit=3',
    );
  });

  it('o 409 de estado não remarcável fica na tela quando a agenda recarregada tira o agendamento, até dispensar', async () => {
    const depois = horario('h-depois', daqui(9 * 1440), 'scheduled', 'Peeling');
    let cancelado = false;
    const chamadas = mockApi(
      clinica([], (c) => {
        if (c.metodo === 'POST') {
          // alguém cancelou o agendamento em outra tela
          cancelado = true;
          return {
            status: 409,
            body: { message: 'Só agendamento marcado ou confirmado pode ser remarcado' },
          };
        }
        if (c.url.startsWith('/api/clinics/appointments?')) {
          const proximo = horario(
            'h-proximo',
            daqui(2 * 1440),
            cancelado ? 'canceled' : 'confirmed',
          );
          return { body: [proximo, depois] };
        }
        return undefined;
      }),
    );
    const painel = renderizar(ESCREVE);
    const sugestao = await within(painel).findByRole('group', { name: 'Sugestão' });
    fireEvent.click(await within(sugestao).findByRole('button', { name: /11:15/ }));
    const agendaAntes = chamadas.filter((c) => c.url.startsWith('/api/clinics/appointments?'));
    fireEvent.click(within(sugestao).getByRole('button', { name: 'Confirmar remarcação' }));
    await within(painel).findByRole('alert');
    await waitFor(() =>
      expect(
        chamadas.filter((c) => c.url.startsWith('/api/clinics/appointments?')).length,
      ).toBeGreaterThan(agendaAntes.length),
    );
    await assentar();
    const fixada = within(painel).getByRole('group', { name: 'Sugestão' });
    expect(fixada).toHaveTextContent('Remarcar Limpeza de pele de');
    expect(within(fixada).getByRole('alert')).toHaveTextContent(
      'Só agendamento marcado ou confirmado pode ser remarcado',
    );
    expect(
      within(fixada)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Dispensar']);
    fireEvent.click(within(fixada).getByRole('button', { name: 'Dispensar' }));
    await waitFor(() =>
      expect(within(painel).getByRole('group', { name: 'Sugestão' })).toHaveTextContent(
        'Remarcar Peeling de',
      ),
    );
    expect(within(painel).queryByRole('alert')).toBeNull();
  });

  it('as opções carregando: o esqueleto com aviso para leitor de tela, sem botão; depois, as opções', async () => {
    const carga = adiado();
    mockApi(
      clinica(HORARIOS, (c) =>
        c.url.includes('/reschedule-options') ? carga.promessa : undefined,
      ),
    );
    const painel = renderizar(ESCREVE);
    const sugestao = await within(painel).findByRole('group', { name: 'Sugestão' });
    expect(await within(sugestao).findByRole('status')).toHaveTextContent(
      'Carregando os horários livres…',
    );
    expect(within(sugestao).queryByRole('button')).toBeNull();
    carga.soltar({ body: opcoesDto(OPCOES) });
    expect(await within(sugestao).findAllByRole('button')).toHaveLength(3);
    expect(within(sugestao).queryByRole('status')).toBeNull();
  });

  it('as opções com erro: "Sugestão indisponível", com o motivo do servidor e sem botão', async () => {
    mockApi(
      clinica(HORARIOS, (c) =>
        c.url.includes('/reschedule-options')
          ? { status: 409, body: { message: 'O horário já começou' } }
          : undefined,
      ),
    );
    const painel = renderizar(ESCREVE);
    const sugestao = await within(painel).findByRole('group', { name: 'Sugestão' });
    expect(
      await within(sugestao).findByText('Sugestão indisponível agora: O horário já começou'),
    ).toBeInTheDocument();
    expect(within(sugestao).queryByRole('button')).toBeNull();
  });

  it('sem agendamento futuro remarcável: nem cartão, nem consulta das opções', async () => {
    const chamadas = mockApi(
      clinica([
        horario('h-em-curso', daqui(-10), 'arrived'),
        horario('h-cancelado', daqui(60), 'canceled'),
        horario('h-passado', daqui(-3 * 1440), 'scheduled'),
      ]),
    );
    const painel = renderizar(ESCREVE);
    const clinico = await within(painel).findByRole('region', { name: 'Contexto clínico' });
    await within(clinico).findByText('Chegou');
    await assentar();
    expect(within(clinico).queryByRole('group', { name: 'Sugestão' })).toBeNull();
    expect(pedidosDeOpcoes(chamadas)).toEqual([]);
  });

  it('sem horário livre no horizonte: diz, sem botão', async () => {
    mockApi(
      clinica(HORARIOS, (c) =>
        c.url.includes('/reschedule-options') ? { body: opcoesDto([]) } : undefined,
      ),
    );
    const painel = renderizar(ESCREVE);
    const sugestao = await within(painel).findByRole('group', { name: 'Sugestão' });
    expect(
      await within(sugestao).findByText(
        'Nenhum horário livre com Dra. Ana Fictícia nos próximos dias.',
      ),
    ).toBeInTheDocument();
    expect(within(sugestao).queryByRole('button')).toBeNull();
  });
});
