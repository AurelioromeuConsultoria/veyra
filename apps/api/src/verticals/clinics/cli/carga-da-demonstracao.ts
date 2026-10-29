/**
 * Os dados FICTÍCIOS da carga da demonstração (ADR-048 adendo 13). Nada aqui
 * é de pessoa real: os nomes dizem "Demonstração"/"Fictícia", e os números têm
 * o prefixo fictício `+55119000002xx` (o mesmo padrão dos testes). As datas são
 * relativas ao dia da carga, no fuso da unidade.
 *
 * As chaves que a reexecução usa (adendo 13, decisão 2): o NOME exato no
 * catálogo e o NÚMERO exato no contato.
 */

export const ORIGEM_DA_DEMONSTRACAO = 'demonstração';

export interface ServicoDaCarga {
  nome: string;
  duracaoMin: number;
  precoCentavos: number | null;
  retornoEmDias: number | null;
}

export const SERVICOS_DA_CARGA: readonly ServicoDaCarga[] = [
  {
    nome: 'Limpeza de pele (demonstração)',
    duracaoMin: 60,
    precoCentavos: 18000,
    retornoEmDias: null,
  },
  {
    nome: 'Peeling químico (demonstração)',
    duracaoMin: 45,
    precoCentavos: 25000,
    retornoEmDias: 30,
  },
  {
    nome: 'Avaliação estética (demonstração)',
    duracaoMin: 30,
    precoCentavos: null,
    retornoEmDias: null,
  },
];

export interface ProfissionalDaCarga {
  nome: string;
  /** índices em SERVICOS_DA_CARGA */
  servicos: readonly number[];
}

export const PROFISSIONAIS_DA_CARGA: readonly ProfissionalDaCarga[] = [
  { nome: 'Dra. Ana Fictícia', servicos: [0, 1, 2] },
  { nome: 'Dra. Beatriz Fictícia', servicos: [0, 2] },
];

/** O expediente: segunda (1) a sábado (6), das 8h às 18h, na unidade. */
export const EXPEDIENTE_DA_CARGA = { dias: [1, 2, 3, 4, 5, 6], inicio: 8 * 60, fim: 18 * 60 };

export interface PacienteDaCarga {
  nome: string;
  numero: string;
  /** o agendamento: o dia útil seguinte à carga (1 = o primeiro), a hora e os índices */
  agendamento?: { diaUtil: number; hora: string; profissional: number; servico: number };
  /** o retorno pendente, vencido há `diasAtras` dias, sem agendamento */
  retorno?: { servico: number; diasAtras: number };
}

export const PACIENTES_DA_CARGA: readonly PacienteDaCarga[] = [
  {
    nome: 'Carla Demonstração',
    numero: '+5511900000201',
    agendamento: { diaUtil: 1, hora: '09:00', profissional: 0, servico: 0 },
  },
  {
    nome: 'Diego Demonstração',
    numero: '+5511900000202',
    agendamento: { diaUtil: 1, hora: '10:30', profissional: 1, servico: 2 },
  },
  {
    nome: 'Elisa Demonstração',
    numero: '+5511900000203',
    agendamento: { diaUtil: 1, hora: '14:00', profissional: 0, servico: 1 },
  },
  {
    nome: 'Fábio Demonstração',
    numero: '+5511900000204',
    agendamento: { diaUtil: 2, hora: '09:30', profissional: 1, servico: 0 },
  },
  {
    nome: 'Gabriela Demonstração',
    numero: '+5511900000205',
    agendamento: { diaUtil: 2, hora: '15:00', profissional: 0, servico: 2 },
  },
  {
    nome: 'Heitor Demonstração',
    numero: '+5511900000206',
    retorno: { servico: 1, diasAtras: 7 },
  },
];
