import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ConsentChannelDto,
  ConsentDto,
  ConsentOrigin,
  ConsentPurposeDto,
  ConsentRevocationReason,
  ContactConsentsDto,
  ConversationConsentsDto,
  ConversationDto,
  StopBlockDto,
} from '@veyra/contracts';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Select } from '../components/ui/input';
import { api } from '../lib/api';
import { useRegistroIdempotente } from '../lib/registro-idempotente';
import { useLinks } from '../lib/experience';
import { hasPermission, useSession } from '../lib/session';

/**
 * O consentimento e o pedido de parar na tela (F4.4b; ADR-048 adendo 12, pelas
 * rotas da F4.1b, ADR-052). Duas entradas: a ficha do contato (consultar,
 * conceder, revogar, parar e desbloquear) e a conversa de WhatsApp (consultar,
 * parar e desbloquear pela conversa, inclusive na RAI). O número nunca é
 * digitado: vem dos números exatos que o servidor devolve, ou da conversa. A
 * origem é a lista fechada. Esconder é usabilidade; o servidor confere tudo.
 */

const ORIGENS: readonly ConsentOrigin[] = ['in_person', 'phone', 'paper_form'];
export const ROTULO_DA_ORIGEM: Record<ConsentOrigin, string> = {
  in_person: 'Presencial',
  phone: 'Por telefone',
  paper_form: 'Formulário em papel',
};
const ROTULO_DA_REVOGACAO: Record<ConsentRevocationReason, string> = {
  manual: 'revogado a pedido',
  number_removed: 'o número saiu do cadastro',
  stop_requested: 'pedido de parar',
};
const dataHora = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const quando = (iso: string) => dataHora.format(new Date(iso));

const AVISO_DO_BLOQUEIO =
  'Com o pedido de parar ativo, nada sai para o número: nem resposta, nem template, nem envio da clínica.';
const AVISO_DO_DESBLOQUEIO =
  'Registra a nova solicitação da pessoa. Nenhum consentimento anterior volta: um novo precisa ser registrado.';

/**
 * Uma ação que pede a origem da manifestação da pessoa, da lista fechada,
 * antes de confirmar. `alvo` distingue ações iguais na mesma seção.
 */
function AcaoComOrigem({
  rotulo,
  confirmar,
  alvo,
  aviso,
  desabilitado,
  variante = 'secondary',
  onConfirmar,
}: {
  rotulo: string;
  confirmar: string;
  alvo?: string;
  aviso?: string;
  desabilitado: boolean;
  variante?: 'secondary' | 'danger';
  onConfirmar: (origem: ConsentOrigin) => void;
}) {
  const [aberta, setAberta] = useState(false);
  const [origem, setOrigem] = useState<ConsentOrigin | ''>('');
  const nome = alvo ? `${rotulo} (${alvo})` : rotulo;
  const fechar = () => {
    setAberta(false);
    setOrigem('');
  };
  if (!aberta) {
    return (
      <Button
        size="sm"
        variant={variante}
        aria-label={nome}
        disabled={desabilitado}
        onClick={() => setAberta(true)}
      >
        {rotulo}
      </Button>
    );
  }
  return (
    <div role="group" aria-label={nome} className="flex w-full flex-wrap items-center gap-2">
      <Select
        size="sm"
        aria-label={`Como a pessoa pediu: ${nome}`}
        value={origem}
        disabled={desabilitado}
        onChange={(e) => setOrigem(e.target.value as ConsentOrigin | '')}
      >
        <option value="">Como a pessoa pediu?</option>
        {ORIGENS.map((o) => (
          <option key={o} value={o}>
            {ROTULO_DA_ORIGEM[o]}
          </option>
        ))}
      </Select>
      <Button
        size="sm"
        variant="primary"
        disabled={desabilitado || origem === ''}
        onClick={() => {
          if (origem === '') return;
          onConfirmar(origem);
          fechar();
        }}
      >
        {confirmar}
      </Button>
      <Button size="sm" variant="ghost" disabled={desabilitado} onClick={fechar}>
        Cancelar
      </Button>
      {aviso ? <p className="w-full text-data-sm text-muted-fg">{aviso}</p> : null}
    </div>
  );
}

/** O resultado do último registro: o recibo, o motivo da recusa ou o indefinido. */
function Desfecho({ registro }: { registro: ReturnType<typeof useRegistroIdempotente> }) {
  return (
    <>
      {registro.feito ? (
        <p role="status" className="text-data text-positive">
          {registro.feito}
        </p>
      ) : null}
      {registro.erro ? (
        <p role="alert" className="text-data text-negative">
          {registro.erro}
        </p>
      ) : null}
      {registro.incerta ? (
        <Button size="sm" variant="primary" disabled={registro.emVoo} onClick={registro.repetir}>
          Repetir o mesmo registro
        </Button>
      ) : null}
    </>
  );
}

function PedidoAtivo({ bloqueio }: { bloqueio: StopBlockDto }) {
  return (
    <span className="text-data-sm">
      <span className="font-medium text-negative">Pedido de parar ativo</span>{' '}
      <span className="num text-muted-fg">
        {bloqueio.receipt} · {ROTULO_DA_ORIGEM[bloqueio.origin]} · {quando(bloqueio.createdAt)}
      </span>
    </span>
  );
}

function ListaDeConsentimentos({
  consentimentos,
  canais,
  acao,
}: {
  consentimentos: ConsentDto[];
  canais: Map<string, string>;
  acao?: (c: ConsentDto) => ReactNode;
}) {
  if (consentimentos.length === 0) {
    return <p className="text-data text-muted-fg">Nenhum consentimento registrado.</p>;
  }
  return (
    <ul className="space-y-2">
      {consentimentos.map((c) => (
        <li key={c.id} className="space-y-1 rounded-md border border-border/70 p-2">
          <p className="text-body-sm">{c.purposeDescription}</p>
          <p className="num text-data-sm text-muted-fg">
            {c.purposeKey} v{c.purposeVersion} · {canais.get(c.channelId) ?? 'canal'} · {c.number} ·{' '}
            {ROTULO_DA_ORIGEM[c.origin]} · {c.receipt} · {quando(c.grantedAt)}
          </p>
          {c.revokedAt ? (
            <p className="text-data-sm text-negative">
              Revogado em {quando(c.revokedAt)}
              {c.revocationReason ? ` (${ROTULO_DA_REVOGACAO[c.revocationReason]})` : ''}
            </p>
          ) : (
            (acao?.(c) ?? null)
          )}
        </li>
      ))}
    </ul>
  );
}

/** A versão mais recente de cada finalidade: é a que se oferece para consentir. */
function maisRecentes(finalidades: ConsentPurposeDto[]): ConsentPurposeDto[] {
  const porChave = new Map<string, ConsentPurposeDto>();
  for (const f of finalidades) {
    const atual = porChave.get(f.key);
    if (!atual || f.version > atual.version) porChave.set(f.key, f);
  }
  return [...porChave.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * A seção da ficha do contato. Lê com `consents:read` e `contacts:read`;
 * concede, revoga e registra o pedido de parar com `consents:manage`; retira o
 * pedido com `consents:unblock`.
 */
export function ConsentimentosDoContato({ contactId }: { contactId: string }) {
  const { data: user } = useSession();
  const podeLer = hasPermission(user, 'consents:read') && hasPermission(user, 'contacts:read');
  const podeGerir = podeLer && hasPermission(user, 'consents:manage');
  const podeDesbloquear = podeLer && hasPermission(user, 'consents:unblock');
  const queryClient = useQueryClient();
  const chave = ['consents', 'contact', contactId] as const;
  const dados = useQuery({
    queryKey: chave,
    queryFn: () => api.get<ContactConsentsDto>(`/api/contacts/${contactId}/consents`),
    enabled: podeLer,
  });
  const canais = useQuery({
    queryKey: ['consent-channels'],
    queryFn: () => api.get<ConsentChannelDto[]>('/api/consent-channels'),
    enabled: podeLer,
  });
  const finalidades = useQuery({
    queryKey: ['consent-purposes'],
    queryFn: () => api.get<ConsentPurposeDto[]>('/api/consent-purposes'),
    enabled: podeGerir,
  });
  const registro = useRegistroIdempotente(
    () => void queryClient.invalidateQueries({ queryKey: chave }),
  );
  const [canal, setCanal] = useState('');
  const [numero, setNumero] = useState('');
  const [finalidade, setFinalidade] = useState('');
  const [origem, setOrigem] = useState<ConsentOrigin | ''>('');

  if (!podeLer) return null;
  const nomes = new Map((canais.data ?? []).map((c) => [c.id, c.name]));
  const d = dados.data;
  const bloqueados = new Set(d?.stopBlocks.map((b) => b.number) ?? []);
  const livres = d?.numbers.filter((n) => !bloqueados.has(n)) ?? [];
  const ofertas = maisRecentes(finalidades.data ?? []);
  const escolhida = ofertas.find((f) => f.id === finalidade) ?? null;
  // o número escolhido só vale enquanto é oferecido: um pedido de parar
  // registrado depois da escolha o tira da lista, e da concessão (revisão F4.4b)
  const numeroValido = livres.includes(numero) ? numero : '';
  const travado = registro.ocupado;

  return (
    <section
      className="space-y-3 border-t border-border pt-4"
      aria-label="Consentimentos e pedido de parar"
      data-testid="consentimentos-do-contato"
    >
      <h3 className="eyebrow text-muted-fg">Consentimentos e pedido de parar</h3>
      {dados.isError ? (
        <p role="alert" className="text-data text-negative">
          Não foi possível carregar os consentimentos.
        </p>
      ) : !d ? (
        <p className="text-data text-muted-fg">Carregando…</p>
      ) : (
        <>
          <div className="space-y-1.5">
            <p className="text-data-sm text-muted-fg">Números do cadastro</p>
            {d.numbers.length === 0 ? (
              <p className="text-data text-muted-fg">
                Nenhum número exato no cadastro: o consentimento e o pedido de parar exigem o
                telefone com o código do país (+55…).
              </p>
            ) : (
              <ul className="space-y-1.5">
                {d.numbers.map((n) => {
                  const bloqueio = d.stopBlocks.find((b) => b.number === n);
                  return (
                    <li key={n} className="flex flex-wrap items-center gap-2">
                      <span className="num text-data">{n}</span>
                      {bloqueio ? (
                        <>
                          <PedidoAtivo bloqueio={bloqueio} />
                          {podeDesbloquear ? (
                            <AcaoComOrigem
                              rotulo="Retirar o pedido"
                              confirmar="Registrar a nova solicitação"
                              alvo={n}
                              aviso={AVISO_DO_DESBLOQUEIO}
                              desabilitado={travado}
                              onConfirmar={(o) =>
                                registro.registrar({
                                  caminho: `/api/contacts/${contactId}/stop/lift`,
                                  corpo: { number: n, origin: o },
                                  rotulo: 'Retirada do pedido de parar',
                                  sucesso: (r) =>
                                    `Pedido de parar retirado: ${(r as StopBlockDto).liftReceipt ?? ''}`,
                                })
                              }
                            />
                          ) : null}
                        </>
                      ) : podeGerir ? (
                        <AcaoComOrigem
                          rotulo="Registrar pedido de parar"
                          confirmar="Registrar o pedido"
                          alvo={n}
                          aviso={AVISO_DO_BLOQUEIO}
                          variante="danger"
                          desabilitado={travado}
                          onConfirmar={(o) =>
                            registro.registrar({
                              caminho: `/api/contacts/${contactId}/stop`,
                              corpo: { number: n, origin: o },
                              rotulo: 'Pedido de parar',
                              sucesso: (r) =>
                                `Pedido de parar registrado: ${(r as StopBlockDto).receipt}`,
                            })
                          }
                        />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            {d.stopBlocks.length > 0 ? (
              <p className="text-data-sm text-muted-fg">{AVISO_DO_BLOQUEIO}</p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <p className="text-data-sm text-muted-fg">Consentimentos (o histórico não se apaga)</p>
            <ListaDeConsentimentos
              consentimentos={d.consents}
              canais={nomes}
              acao={
                podeGerir
                  ? (c) => (
                      <AcaoComOrigem
                        rotulo="Revogar"
                        confirmar="Revogar o consentimento"
                        alvo={c.receipt}
                        variante="danger"
                        desabilitado={travado}
                        onConfirmar={(o) =>
                          registro.registrar({
                            caminho: `/api/contacts/${contactId}/consents/${c.id}/revoke`,
                            corpo: { origin: o },
                            rotulo: 'Revogação',
                            sucesso: () => `Consentimento ${c.receipt} revogado`,
                          })
                        }
                      />
                    )
                  : undefined
              }
            />
          </div>

          {podeGerir ? (
            <fieldset
              disabled={travado}
              className="space-y-2 rounded-md border border-border/70 p-3"
            >
              <legend className="px-1 text-data-sm text-muted-fg">Registrar consentimento</legend>
              {livres.length === 0 ? (
                <p className="text-data text-muted-fg">
                  {d.numbers.length === 0
                    ? 'Sem número exato no cadastro, não há o que consentir.'
                    : 'Os números deste contato estão com pedido de parar: nenhum consentimento pode ser registrado.'}
                </p>
              ) : (
                <>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Select
                      size="sm"
                      full
                      aria-label="Canal do consentimento"
                      value={canal}
                      onChange={(e) => setCanal(e.target.value)}
                    >
                      <option value="">Canal…</option>
                      {(canais.data ?? []).map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                    <Select
                      size="sm"
                      full
                      aria-label="Número do consentimento"
                      value={numeroValido}
                      onChange={(e) => setNumero(e.target.value)}
                    >
                      <option value="">Número…</option>
                      {livres.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </Select>
                    <Select
                      size="sm"
                      full
                      aria-label="Finalidade do consentimento"
                      value={finalidade}
                      onChange={(e) => setFinalidade(e.target.value)}
                    >
                      <option value="">Finalidade…</option>
                      {ofertas.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.key} v{f.version}
                        </option>
                      ))}
                    </Select>
                    <Select
                      size="sm"
                      full
                      aria-label="Origem do consentimento"
                      value={origem}
                      onChange={(e) => setOrigem(e.target.value as ConsentOrigin | '')}
                    >
                      <option value="">Como a pessoa consentiu?</option>
                      {ORIGENS.map((o) => (
                        <option key={o} value={o}>
                          {ROTULO_DA_ORIGEM[o]}
                        </option>
                      ))}
                    </Select>
                  </div>
                  {escolhida ? (
                    <p className="text-data" data-testid="descricao-aceita">
                      A pessoa aceita: “{escolhida.description}”
                    </p>
                  ) : null}
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!canal || !numeroValido || !escolhida || !origem}
                    onClick={() => {
                      if (!escolhida || !origem || !numeroValido) return;
                      registro.registrar({
                        caminho: `/api/contacts/${contactId}/consents`,
                        corpo: {
                          channelId: canal,
                          number: numeroValido,
                          purposeId: escolhida.id,
                          origin: origem,
                        },
                        rotulo: 'Consentimento',
                        sucesso: (r) => `Consentimento registrado: ${(r as ConsentDto).receipt}`,
                        aoConcluir: () => {
                          setFinalidade('');
                          setOrigem('');
                        },
                      });
                    }}
                  >
                    Registrar consentimento
                  </Button>
                  <p className="text-data-sm text-muted-fg">
                    O recibo identifica o registro no sistema; não prova sozinho que a pessoa
                    consentiu.
                  </p>
                </>
              )}
            </fieldset>
          ) : null}
        </>
      )}
      <Desfecho registro={registro} />
    </section>
  );
}

/**
 * Pela conversa de WhatsApp: consulta, pedido de parar e desbloqueio, pela rota
 * da conversa — inclusive na RAI, sem atribuí-la (para ela, o servidor exige
 * também `contacts:write`, C13). Conceder e revogar são da ficha do contato.
 */
export function podeVerConsentimentoDaConversa(
  user: Parameters<typeof hasPermission>[0],
  conversa: Pick<ConversationDto, 'channelType' | 'senderStatus'>,
): boolean {
  return (
    conversa.channelType === 'whatsapp' &&
    hasPermission(user, 'consents:read') &&
    hasPermission(user, 'conversations:read') &&
    (conversa.senderStatus !== 'unidentified' || hasPermission(user, 'contacts:write'))
  );
}

export function ConsentimentoDaConversa({ conversa }: { conversa: ConversationDto }) {
  const { data: user } = useSession();
  const links = useLinks();
  const podeLer = podeVerConsentimentoDaConversa(user, conversa);
  const podeGerir = podeLer && hasPermission(user, 'consents:manage');
  const podeDesbloquear = podeLer && hasPermission(user, 'consents:unblock');
  const queryClient = useQueryClient();
  const chave = ['consents', 'conversation', conversa.id] as const;
  const dados = useQuery({
    queryKey: chave,
    queryFn: () => api.get<ConversationConsentsDto>(`/api/conversations/${conversa.id}/consents`),
    enabled: podeLer,
  });
  const canais = useQuery({
    queryKey: ['consent-channels'],
    queryFn: () => api.get<ConsentChannelDto[]>('/api/consent-channels'),
    enabled: podeLer,
  });
  const registro = useRegistroIdempotente(
    () => void queryClient.invalidateQueries({ queryKey: chave }),
  );

  if (!podeLer) {
    return <p className="text-data text-muted-fg">Você não vê os consentimentos desta conversa.</p>;
  }
  const d = dados.data;
  const rai = conversa.senderStatus === 'unidentified';
  // o destino é o do produto ativo (ADR-055): sem resolvedor ou sem a
  // permissão, nenhum link
  const fichaDoContato =
    !rai && conversa.contactId !== null
      ? (links.contato?.(conversa.contactId, user) ?? null)
      : null;
  return (
    <section className="space-y-3" data-testid="consentimento-da-conversa">
      {dados.isError ? (
        <p role="alert" className="text-data text-negative">
          Não foi possível carregar os consentimentos.
        </p>
      ) : !d ? (
        <p className="text-data text-muted-fg">Carregando…</p>
      ) : d.number === null ? (
        <p className="text-data text-muted-fg">Esta conversa não tem número.</p>
      ) : (
        <>
          <p className="text-data">
            Número da conversa: <span className="num">{d.number}</span>
          </p>
          {rai ? (
            <p className="text-data-sm text-muted-fg">
              Remetente a identificar: o pedido de parar vale para o número, sem atribuir a conversa
              a um contato.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {d.stopBlock ? (
              <>
                <PedidoAtivo bloqueio={d.stopBlock} />
                {podeDesbloquear ? (
                  <AcaoComOrigem
                    rotulo="Retirar o pedido"
                    confirmar="Registrar a nova solicitação"
                    aviso={AVISO_DO_DESBLOQUEIO}
                    desabilitado={registro.ocupado}
                    onConfirmar={(o) =>
                      registro.registrar({
                        caminho: `/api/conversations/${conversa.id}/stop/lift`,
                        corpo: { origin: o },
                        rotulo: 'Retirada do pedido de parar',
                        sucesso: (r) =>
                          `Pedido de parar retirado: ${(r as StopBlockDto).liftReceipt ?? ''}`,
                      })
                    }
                  />
                ) : null}
              </>
            ) : podeGerir ? (
              <AcaoComOrigem
                rotulo="Registrar pedido de parar"
                confirmar="Registrar o pedido"
                aviso={AVISO_DO_BLOQUEIO}
                variante="danger"
                desabilitado={registro.ocupado}
                onConfirmar={(o) =>
                  registro.registrar({
                    caminho: `/api/conversations/${conversa.id}/stop`,
                    corpo: { origin: o },
                    rotulo: 'Pedido de parar',
                    sucesso: (r) => `Pedido de parar registrado: ${(r as StopBlockDto).receipt}`,
                  })
                }
              />
            ) : (
              <p className="text-data text-muted-fg">Sem pedido de parar para este número.</p>
            )}
          </div>
          {d.stopBlock ? <p className="text-data-sm text-muted-fg">{AVISO_DO_BLOQUEIO}</p> : null}
          {!rai ? (
            <div className="space-y-1.5">
              <p className="text-data-sm text-muted-fg">Consentimentos deste número</p>
              <ListaDeConsentimentos
                consentimentos={d.consents}
                canais={new Map((canais.data ?? []).map((c) => [c.id, c.name]))}
              />
            </div>
          ) : null}
          {fichaDoContato ? (
            <Link to={fichaDoContato} className="text-data text-accent underline">
              Registrar ou revogar consentimento na ficha do contato
            </Link>
          ) : null}
        </>
      )}
      <Desfecho registro={registro} />
    </section>
  );
}
