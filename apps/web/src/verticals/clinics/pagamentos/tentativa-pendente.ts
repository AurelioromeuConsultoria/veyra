import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ClinicsPackagePaymentsDto } from '@veyra/contracts/verticals/clinics';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { ApiError, api } from '../../../lib/api';
import { resultadoIndefinido } from '../../../lib/registro-idempotente';
import { escopoAtual } from '../../../lib/session-scope';

/** A chave das consultas de pagamento: a lista e o painel, invalidados juntos. */
export const PAYMENTS_KEY = ['clinics', 'package-payments'] as const;
/** A consulta do painel de um pacote (o histórico e o saldo). */
export const chaveDoPacote = (packageId: string) =>
  [...PAYMENTS_KEY, 'package', packageId] as const;
export const lerPacote = (packageId: string) =>
  api.get<ClinicsPackagePaymentsDto>(
    `/api/clinics/packages/${encodeURIComponent(packageId)}/payments`,
  );

/**
 * A tentativa pendente de um pacote (ADR-063, ajustes da F6.1a): o registro ou a
 * anulação cujo resultado não chegou (rede, prazo, 5xx, 409 "em processamento").
 *
 * O pedido — o corpo e a `Idempotency-Key` — fica FORA do ciclo de vida do
 * painel: num mapa do módulo, espelhado no `sessionStorage` (sobrevive a fechar
 * e reabrir o painel, à recarga da lista e à da página, e some ao fechar a aba).
 * Nunca no servidor. A chave do armazenamento leva o escopo da sessão
 * (identidade + membership + experiência, ADR-050): outra sessão na mesma aba
 * não vê nem repete a tentativa de outra — repetir com outra sessão criaria
 * outro lançamento, porque a idempotência do servidor é por membership.
 *
 * Enquanto houver tentativa, o pacote fica BLOQUEADO: nenhuma operação nova
 * (registrar ou anular). Não há como abandoná-la — só "Tentar de novo" (o MESMO
 * pedido, com a MESMA chave) chega ao resultado definitivo (2xx, ou a recusa
 * 4xx com o motivo). Uma leitura do histórico, vazia ou não, não resolve nada.
 * Com o resultado definitivo, o histórico e o saldo são relidos; só a leitura
 * bem-sucedida, iniciada DEPOIS do resultado, libera o pacote. Nada aqui gera
 * chave nova sozinho.
 */
export interface Tentativa {
  tipo: 'registrar' | 'anular';
  chave: string;
  caminho: string;
  corpo: unknown;
  /** o que o pedido faz, para a tela: "Pagamento de R$ 600,00 em pix, recebido em…" */
  resumo: string;
  /** o que dizer quando o servidor confirmar (o corpo não muda, então já se sabe) */
  confirmacao: string;
  /** o resultado definitivo, já recebido; falta a releitura para liberar */
  desfecho?: Desfecho;
}

interface Desfecho {
  ok: boolean;
  mensagem: string;
}

/** O que a tela diz depois de liberado: a confirmação ou o motivo da recusa. */
interface Aviso {
  feito: string | null;
  erro: string | null;
}

const SEM_AVISO: Aviso = { feito: null, erro: null };

const PREFIXO = 'veyra:clinics:pagamento-pendente:';
/** escopo da sessão + pacote → a tentativa */
const memoria = new Map<string, Tentativa>();
/** as chaves com requisição em voo NESTA página (o armazenado nunca está em voo) */
const emVoo = new Set<string>();
/** as chaves cuja releitura (depois do resultado definitivo) está em curso */
const relendo = new Set<string>();
/** as chaves cuja última releitura falhou: seguem bloqueadas, com "Recarregar" */
const releituraFalhou = new Set<string>();
/** escopo da sessão + pacote → o aviso; muda junto com a tentativa, sem tela no meio */
const avisos = new Map<string, Aviso>();
const ouvintes = new Set<() => void>();
let versao = 0;

function avisar() {
  versao += 1;
  for (const o of ouvintes) o();
}

function chaveDe(packageId: string): string | null {
  const escopo = escopoAtual();
  // sem sessão conhecida, nada é guardado nem lido (fail-closed)
  return typeof escopo === 'string' ? `${PREFIXO}${escopo}:${packageId}` : null;
}

function ler(packageId: string): Tentativa | null {
  const k = chaveDe(packageId);
  if (!k) return null;
  const naMemoria = memoria.get(k);
  if (naMemoria) return naMemoria;
  try {
    const bruto = sessionStorage.getItem(k);
    if (!bruto) return null;
    const t = JSON.parse(bruto) as Tentativa;
    if (typeof t?.chave !== 'string' || typeof t?.caminho !== 'string') return null;
    memoria.set(k, t);
    return t;
  } catch {
    return null;
  }
}

function guardar(packageId: string, t: Tentativa): void {
  const k = chaveDe(packageId);
  if (!k) return;
  memoria.set(k, t);
  try {
    sessionStorage.setItem(k, JSON.stringify(t));
  } catch {
    // sem sessionStorage (modo privado, cota): fica só a memória do módulo
  }
  avisar();
}

/** Some a tentativa já resolvida E relida — e entra o aviso, na mesma mudança. */
function esquecer(packageId: string, chave: string, aviso: Aviso): void {
  const k = chaveDe(packageId);
  if (!k) return;
  // só esquece a MESMA tentativa (nunca outra que tenha tomado o lugar)
  if (memoria.get(k)?.chave === chave) memoria.delete(k);
  try {
    const bruto = sessionStorage.getItem(k);
    if (bruto && (JSON.parse(bruto) as Tentativa).chave === chave) sessionStorage.removeItem(k);
  } catch {
    // idem
  }
  avisos.set(k, aviso);
  avisar();
}

function lerAviso(packageId: string): Aviso {
  const k = chaveDe(packageId);
  return (k && avisos.get(k)) || SEM_AVISO;
}

function limparAviso(packageId: string): void {
  const k = chaveDe(packageId);
  if (k && avisos.delete(k)) avisar();
}

/** Para os testes: esquece tudo (memória e armazenamento deste módulo). */
export function limparTentativasPendentes(): void {
  memoria.clear();
  emVoo.clear();
  relendo.clear();
  releituraFalhou.clear();
  avisos.clear();
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i -= 1) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(PREFIXO)) sessionStorage.removeItem(k);
    }
  } catch {
    // idem
  }
  avisar();
}

const assinar = (o: () => void) => {
  ouvintes.add(o);
  return () => ouvintes.delete(o);
};

/**
 * A releitura que libera o pacote; o chamador já marcou `relendo`. A leitura em
 * curso pode ter começado ANTES do resultado (e não mostrar o que foi gravado):
 * é cancelada, e a consulta é refeita do zero. Só a leitura bem-sucedida libera;
 * a que falha deixa o pacote bloqueado, com "Recarregar".
 */
async function releer(queryClient: QueryClient, packageId: string, t: Tentativa): Promise<void> {
  const desfecho = t.desfecho;
  if (!desfecho) return;
  try {
    const chave = chaveDoPacote(packageId);
    await queryClient.cancelQueries({ queryKey: chave, exact: true });
    await queryClient.fetchQuery({
      queryKey: chave,
      queryFn: () => lerPacote(packageId),
      staleTime: 0,
    });
  } catch {
    relendo.delete(t.chave);
    releituraFalhou.add(t.chave);
    avisar();
    return;
  }
  // a lista (o saldo de cada pacote) também; não é ela que libera
  void queryClient.invalidateQueries({ queryKey: [...PAYMENTS_KEY, 'patient'] });
  relendo.delete(t.chave);
  releituraFalhou.delete(t.chave);
  esquecer(
    packageId,
    t.chave,
    desfecho.ok
      ? { feito: desfecho.mensagem, erro: null }
      : { feito: null, erro: desfecho.mensagem },
  );
}

/** Relê, se há resultado definitivo esperando e nenhuma releitura em curso. */
function iniciarReleitura(queryClient: QueryClient, packageId: string): void {
  const t = ler(packageId);
  if (!t?.desfecho || relendo.has(t.chave)) return;
  relendo.add(t.chave);
  releituraFalhou.delete(t.chave);
  avisar();
  void releer(queryClient, packageId, t);
}

/** O pacote tem tentativa (incerta ou à espera da releitura)? Para a lista. */
export function useTemTentativa(packageId: string): boolean {
  useSyncExternalStore(assinar, () => versao);
  return ler(packageId) !== null;
}

/**
 * O envio idempotente de um pacote. `pendente` é a tentativa ainda não liberada
 * (incerta, em voo ou à espera da releitura); enquanto existir, nada novo é
 * enviado.
 */
export function useTentativaDoPacote(packageId: string) {
  const queryClient = useQueryClient();
  // a versão muda a cada alteração do mapa: relê a tentativa do pacote
  useSyncExternalStore(assinar, () => versao);
  const pendente = ler(packageId);
  const aviso = lerAviso(packageId);
  // só o caso sem sessão conhecida, em que não há onde guardar nada
  const [erroSemSessao, setErroSemSessao] = useState<string | null>(null);

  // o painel reaberto com o resultado já recebido e a releitura parada: relê
  // o aviso vale para esta abertura do painel: ao fechar, some
  useEffect(() => {
    iniciarReleitura(queryClient, packageId);
    return () => limparAviso(packageId);
  }, [queryClient, packageId]);

  const mandar = useCallback(
    async (t: Tentativa) => {
      if (emVoo.has(t.chave)) return;
      emVoo.add(t.chave);
      avisar();
      let desfecho: Desfecho;
      try {
        await api.postIdempotente<unknown>(t.caminho, t.corpo, t.chave);
        desfecho = { ok: true, mensagem: t.confirmacao };
      } catch (e) {
        if (resultadoIndefinido(e)) {
          // a tentativa fica, com a mesma chave; a tela pede "Tentar de novo"
          emVoo.delete(t.chave);
          avisar();
          // o histórico atualizado ajuda a conferir, mas não resolve a pendência
          void queryClient.invalidateQueries({ queryKey: PAYMENTS_KEY });
          return;
        }
        desfecho = {
          ok: false,
          mensagem:
            e instanceof ApiError && e.code === 'idempotency_expired'
              ? 'A tentativa anterior expirou sem resultado confirmado. Confira o histórico antes de registrar de novo.'
              : e instanceof Error
                ? e.message
                : 'Falha ao enviar',
        };
      }
      // resultado definitivo: guardado com a tentativa (sobrevive a fechar o
      // painel), e a releitura começa sem intervalo em que o pacote pareça livre
      const resolvida: Tentativa = { ...t, desfecho };
      relendo.add(t.chave);
      emVoo.delete(t.chave);
      guardar(packageId, resolvida);
      await releer(queryClient, packageId, resolvida);
    },
    [packageId, queryClient],
  );

  return {
    pendente,
    emVoo: pendente !== null && emVoo.has(pendente.chave),
    /** o resultado definitivo chegou e a releitura está em curso */
    relendo: pendente !== null && relendo.has(pendente.chave),
    /** o resultado definitivo chegou, mas a releitura falhou: segue bloqueado */
    releituraFalhou: pendente !== null && releituraFalhou.has(pendente.chave),
    erro: erroSemSessao ?? aviso.erro,
    feito: aviso.feito,
    /** um pedido NOVO: só sem tentativa pendente; a chave nasce aqui, uma vez */
    enviar: (t: Omit<Tentativa, 'chave' | 'desfecho'>) => {
      if (ler(packageId)) return;
      setErroSemSessao(null);
      limparAviso(packageId);
      if (!chaveDe(packageId)) {
        // sem a sessão conhecida, a tentativa não teria onde ficar: não sai
        setErroSemSessao('A sessão ainda não foi confirmada. Recarregue a página e tente de novo.');
        return;
      }
      const tentativa: Tentativa = { ...t, chave: crypto.randomUUID() };
      // guardada ANTES de sair: se o painel fechar em voo, a intenção fica
      guardar(packageId, tentativa);
      void mandar(tentativa);
    },
    /** o MESMO pedido, com a MESMA chave — a única saída da incerteza */
    repetir: () => {
      const t = ler(packageId);
      if (!t || t.desfecho) return;
      void mandar(t);
    },
    /** o resultado já chegou e a releitura falhou: lê de novo */
    recarregar: () => iniciarReleitura(queryClient, packageId),
    limparAvisos: () => {
      setErroSemSessao(null);
      limparAviso(packageId);
    },
  };
}
