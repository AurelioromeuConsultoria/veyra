import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from './api';

/**
 * O resultado é INDEFINIDO: a rede caiu, o servidor falhou (5xx) ou o 409 pede
 * a mesma requisição de novo (`idempotency_retry`, em processamento). O 4xx
 * restante é definitivo — inclusive o 409 de domínio ("sob pedido de parar",
 * "já revogado") e o da chave expirada (`idempotency_expired`).
 */
export function resultadoIndefinido(erro: unknown): boolean {
  if (!(erro instanceof ApiError)) return true;
  return erro.status >= 500 || (erro.status === 409 && erro.code === 'idempotency_retry');
}

interface Tentativa {
  chave: string;
  caminho: string;
  corpo: unknown;
  /** o nome do registro nas mensagens ("Consentimento", "Pedido de parar"…) */
  rotulo: string;
  /** o que dizer quando deu certo (o recibo emitido pelo servidor) */
  sucesso: (resposta: unknown) => string;
  aoConcluir?: () => void;
}

/**
 * Um registro com `Idempotency-Key` (F4.4b; ADR-048 adendo 12). A chave nasce
 * na primeira submissão. Com o resultado indefinido, a chave e o corpo ficam,
 * a seção trava e só o MESMO registro pode ser repetido — nunca outro, com
 * outra chave. O definitivo mostra o motivo do servidor e descarta a chave.
 * Toda resposta chama `depois` (a seção relê o que o servidor tem).
 */
export function useRegistroIdempotente(depois: () => void) {
  const [incerta, setIncerta] = useState<Tentativa | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [feito, setFeito] = useState<string | null>(null);
  const registro = useMutation({
    mutationFn: (t: Tentativa) => api.postIdempotente<unknown>(t.caminho, t.corpo, t.chave),
    onSuccess: (resposta, t) => {
      setIncerta(null);
      setErro(null);
      setFeito(t.sucesso(resposta));
      t.aoConcluir?.();
      depois();
    },
    onError: (e, t) => {
      if (resultadoIndefinido(e)) {
        setIncerta(t);
        setErro(
          `${t.rotulo}: o resultado não chegou. Repita o mesmo registro: ele não cria outro.`,
        );
      } else {
        setIncerta(null);
        // a chave expirada não se repete: seria uma intenção antiga executada de
        // novo, talvez depois de uma revogação (revisão de segurança da F4.4b)
        setErro(
          e instanceof ApiError && e.code === 'idempotency_expired'
            ? `${t.rotulo}: a tentativa anterior expirou sem resultado confirmado. Confira a seção antes de registrar de novo.`
            : e instanceof Error
              ? e.message
              : `${t.rotulo}: falha ao registrar`,
        );
      }
      depois();
    },
  });

  return {
    registrar: (t: Omit<Tentativa, 'chave'>) => {
      if (incerta || registro.isPending) return;
      setFeito(null);
      setErro(null);
      registro.mutate({ ...t, chave: crypto.randomUUID() });
    },
    /** a MESMA tentativa: a mesma chave e o mesmo corpo */
    repetir: () => {
      if (incerta && !registro.isPending) registro.mutate(incerta);
    },
    /** trava tudo o que registraria outra coisa */
    ocupado: incerta !== null || registro.isPending,
    emVoo: registro.isPending,
    incerta: incerta?.rotulo ?? null,
    erro,
    feito,
  };
}
