import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { ApiError, api } from '../../../lib/api';
import { resultadoIndefinido } from '../../../lib/registro-idempotente';
import { escopoAtual } from '../../../lib/session-scope';

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
 * Só "Tentar de novo" (o MESMO pedido, com a MESMA chave) ou "Descartar" (a
 * pessoa desiste) resolvem a incerteza. Nada aqui gera chave nova sozinho.
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
}

const PREFIXO = 'veyra:clinics:pagamento-pendente:';
/** escopo da sessão + pacote → a tentativa */
const memoria = new Map<string, Tentativa>();
/** as chaves com requisição em voo NESTA página (o armazenado nunca está em voo) */
const emVoo = new Set<string>();
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

function esquecer(packageId: string, chave: string): void {
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
  avisar();
}

/** Para os testes: esquece tudo (memória e armazenamento deste módulo). */
export function limparTentativasPendentes(): void {
  memoria.clear();
  emVoo.clear();
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
 * O envio idempotente de um pacote. `pendente` é a tentativa sem resultado
 * confirmado (ou ainda em voo); enquanto existir, nada novo é enviado.
 */
export function useTentativaDoPacote(packageId: string) {
  const queryClient = useQueryClient();
  // a versão muda a cada alteração do mapa: relê a tentativa do pacote
  useSyncExternalStore(assinar, () => versao);
  const pendente = ler(packageId);
  const [erro, setErro] = useState<string | null>(null);
  const [feito, setFeito] = useState<string | null>(null);

  const mandar = useCallback(
    async (t: Tentativa) => {
      if (emVoo.has(t.chave)) return;
      emVoo.add(t.chave);
      avisar();
      try {
        await api.postIdempotente<unknown>(t.caminho, t.corpo, t.chave);
        emVoo.delete(t.chave);
        esquecer(packageId, t.chave);
        setErro(null);
        setFeito(t.confirmacao);
      } catch (e) {
        emVoo.delete(t.chave);
        if (resultadoIndefinido(e)) {
          // a tentativa fica, com a mesma chave; a tela pede "Tentar de novo"
          avisar();
        } else {
          esquecer(packageId, t.chave);
          setErro(
            e instanceof ApiError && e.code === 'idempotency_expired'
              ? 'A tentativa anterior expirou sem resultado confirmado. Confira o histórico antes de registrar de novo.'
              : e instanceof Error
                ? e.message
                : 'Falha ao enviar',
          );
        }
      } finally {
        // toda resposta relê o que o servidor tem (lista e painel)
        void queryClient.invalidateQueries({ queryKey: ['clinics', 'package-payments'] });
      }
    },
    [packageId, queryClient],
  );

  return {
    pendente,
    emVoo: pendente !== null && emVoo.has(pendente.chave),
    erro,
    feito,
    /** um pedido NOVO: só sem tentativa pendente; a chave nasce aqui, uma vez */
    enviar: (t: Omit<Tentativa, 'chave'>) => {
      if (ler(packageId)) return;
      setErro(null);
      setFeito(null);
      if (!chaveDe(packageId)) {
        // sem a sessão conhecida, a tentativa não teria onde ficar: não sai
        setErro('A sessão ainda não foi confirmada. Recarregue a página e tente de novo.');
        return;
      }
      const tentativa: Tentativa = { ...t, chave: crypto.randomUUID() };
      // guardada ANTES de sair: se o painel fechar em voo, a intenção fica
      guardar(packageId, tentativa);
      void mandar(tentativa);
    },
    /** o MESMO pedido, com a MESMA chave */
    repetir: () => {
      const t = ler(packageId);
      if (!t) return;
      setErro(null);
      setFeito(null);
      void mandar(t);
    },
    /** a pessoa desiste: só então a intenção some */
    descartar: () => {
      const t = ler(packageId);
      if (t && !emVoo.has(t.chave)) esquecer(packageId, t.chave);
    },
    limparAvisos: () => {
      setErro(null);
      setFeito(null);
    },
  };
}
