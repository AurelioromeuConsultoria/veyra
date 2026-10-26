import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConversationDto, ConversationSenderCandidateDto } from '@veyra/contracts';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { api, ApiError } from '../lib/api';

/**
 * O REMETENTE de uma conversa (ADR-052 item 2). A conversa "remetente a
 * identificar" (RAI) nasce quando o número que escreveu pertence a mais de um
 * contato, ou só coincide por aproximação: nada a atribui sozinho, e quem
 * decide é uma pessoa. A tela só aparece para quem pode decidir (o servidor
 * confere de novo): `conversations:write`, `contacts:write` e `contacts:read`.
 *
 * - RAI: os candidatos, com "exato" ou "possível", e um contato novo;
 * - identificada por uma pessoa: desfazer;
 * - identificada: "o remetente não é este contato", com a opção de tirar o
 *   número do cadastro — sem isso, a próxima mensagem do número volta a cair
 *   no contato;
 * - a conversa do LEGADO (mensagens de antes da atualização, ligadas ao
 *   contato): nenhum ato, só o aviso — o servidor recusaria com 409.
 */
export function SenderPanel({
  conversation,
  onChanged,
}: {
  conversation: ConversationDto;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [erro, setErro] = useState<string | null>(null);
  const [novoNome, setNovoNome] = useState('');
  const [rejeitando, setRejeitando] = useState(false);
  const [tirarNumero, setTirarNumero] = useState(false);
  const rai = conversation.senderStatus === 'unidentified';

  const candidatos = useQuery({
    queryKey: ['conversation-sender-candidates', conversation.id],
    queryFn: () =>
      api.get<ConversationSenderCandidateDto[]>(
        `/api/conversations/${conversation.id}/sender/candidates`,
      ),
    enabled: rai,
  });

  const depois = () => {
    setErro(null);
    setNovoNome('');
    setRejeitando(false);
    setTirarNumero(false);
    void queryClient.invalidateQueries({ queryKey: ['conversation-sender-candidates'] });
    onChanged();
  };
  const falhou = (e: unknown) =>
    setErro(e instanceof ApiError ? e.message : 'Não foi possível concluir. Tente de novo.');

  const identificar = useMutation({
    mutationFn: (corpo: { contactId: string } | { newContact: { name: string } }) =>
      api.post<ConversationDto>(`/api/conversations/${conversation.id}/sender/identify`, corpo),
    onSuccess: depois,
    onError: falhou,
  });
  const desfazer = useMutation({
    mutationFn: () =>
      api.post<ConversationDto>(`/api/conversations/${conversation.id}/sender/unidentify`, {}),
    onSuccess: depois,
    onError: falhou,
  });
  const rejeitar = useMutation({
    mutationFn: (removeNumber: boolean) =>
      api.post<ConversationDto>(`/api/conversations/${conversation.id}/sender/reject`, {
        removeNumber,
      }),
    onSuccess: depois,
    onError: falhou,
  });
  const ocupado = identificar.isPending || desfazer.isPending || rejeitar.isPending;

  if (conversation.senderRelinkBlocked) {
    return (
      <section aria-label="Remetente" className="border-b border-border px-6 py-3">
        <p className="text-data text-muted-fg">
          Esta conversa tem mensagens anteriores à atualização, ligadas ao contato. Corrigir o
          remetente dela ainda não é possível.
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Remetente" className="space-y-2 border-b border-border px-6 py-3">
      {erro ? (
        <p role="alert" className="text-data text-negative">
          {erro}
        </p>
      ) : null}
      {rai ? (
        <>
          <p className="text-body-sm">
            <span className="font-medium">Remetente a identificar.</span> Não há certeza de quem
            escreveu do número {conversation.senderAddress ?? ''}: ele pode estar em mais de um
            contato, só coincidir por aproximação, ou a identificação ter sido desfeita. Nada é
            atribuído sozinho.
          </p>
          <p className="text-data text-muted-fg">
            Para responder, identifique primeiro quem escreveu. A identificação vale só para esta
            conversa: enquanto o número estiver em mais de um contato, as próximas mensagens dele
            voltam para cá.
          </p>
          {candidatos.isError ? (
            <p role="alert" className="text-data text-negative">
              Não foi possível carregar os candidatos.
            </p>
          ) : null}
          {candidatos.data && !candidatos.isError ? (
            <ul aria-label="Candidatos a remetente" className="space-y-1">
              {candidatos.data.map((c) => (
                <li key={c.contactId} className="flex items-center gap-2 text-body-sm">
                  <span className="min-w-0 flex-1 truncate">
                    {c.name}{' '}
                    <span className="text-data text-muted-fg">
                      {c.match === 'exact'
                        ? '(número exato)'
                        : '(número possível: responder exigirá o número exato no cadastro)'}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={ocupado}
                    aria-label={`Identificar como ${c.name}`}
                    onClick={() => identificar.mutate({ contactId: c.contactId })}
                  >
                    É esta pessoa
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (novoNome.trim()) identificar.mutate({ newContact: { name: novoNome.trim() } });
            }}
          >
            <Input
              className="h-8 text-data"
              placeholder="Nome de um contato novo"
              aria-label="Nome do contato novo"
              value={novoNome}
              onChange={(e) => setNovoNome(e.target.value)}
            />
            <Button type="submit" size="sm" variant="ghost" disabled={ocupado || !novoNome.trim()}>
              Criar e identificar
            </Button>
          </form>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {conversation.senderIdentifiedByPerson ? (
            <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => desfazer.mutate()}>
              Desfazer identificação
            </Button>
          ) : null}
          {rejeitando ? (
            <div className="space-y-2">
              <label className="flex items-start gap-2 text-body-sm">
                <input
                  type="checkbox"
                  checked={tirarNumero}
                  onChange={(e) => setTirarNumero(e.target.checked)}
                />
                <span>
                  Tirar este número do cadastro do contato, em qualquer formato em que esteja
                  escrito
                </span>
              </label>
              {!tirarNumero ? (
                <p className="text-data text-muted-fg">
                  Sem tirar o número, a próxima mensagem dele volta a cair neste contato.
                </p>
              ) : null}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="danger"
                  disabled={ocupado}
                  onClick={() => rejeitar.mutate(tirarNumero)}
                >
                  Confirmar: o remetente não é este contato
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRejeitando(false)}>
                  Voltar
                </Button>
              </div>
            </div>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={ocupado}
              onClick={() => setRejeitando(true)}
            >
              O remetente não é este contato
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
