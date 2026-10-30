import { useQuery } from '@tanstack/react-query';
import type { ContactDto, ConversationPageDto, CustomFieldDto, DealDto } from '@veyra/contracts';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../../components/ui/button';
import { Drawer } from '../../../components/ui/drawer';
import { Panel } from '../../../components/ui/page';
import { TagBadge } from '../../../components/ui/tag-badge';
import { api, toQuery } from '../../../lib/api';
import { formatCents, relativeStamp } from '../../../lib/format';
import { alcanca, useSession } from '../../../lib/session';
import { ConsentimentosDoContato } from '../../../pages/Consentimentos';
import { DadosDoContato } from './DadosDoContato';

const CONVERSAS_NA_FICHA = 5;
/** o teto do serviço do Core (`listByContact`): no teto, a seção diz que é parte */
const TETO_DAS_OPORTUNIDADES = 100;
const ESTADO_DA_OPORTUNIDADE = { open: 'em aberto', won: 'ganha', lost: 'perdida' } as const;

/**
 * O contato da pessoa, na clínica (ADR-055, adendos 3, 4 e 5): os dados, o
 * consentimento, as conversas e as oportunidades — o paciente continua na
 * captação. Cada parte só aparece, e só consulta, com TODAS as chaves que a
 * rota dela exige. Nada aqui diz se a pessoa é paciente.
 */
export function ContatoDaPessoa({ contactId }: { contactId: string }) {
  const { data: user } = useSession();
  const leContato = alcanca(user, { permission: 'contacts:read' });
  const leConversas = alcanca(user, { permissions: ['conversations:read', 'contacts:read'] });
  const leOportunidades = alcanca(user, { permissions: ['pipelines:read', 'contacts:read'] });
  const editaContato = alcanca(user, { permission: 'contacts:write' });
  const [editando, setEditando] = useState(false);

  const contato = useQuery({
    queryKey: ['contact', contactId],
    queryFn: () => api.get<ContactDto>(`/api/contacts/${contactId}`),
    enabled: leContato,
  });
  // os rótulos dos campos personalizados: as definições do Core (adendo 5)
  const definicoes = useQuery({
    queryKey: ['custom-fields', 'contact'],
    queryFn: () => api.get<CustomFieldDto[]>('/api/custom-fields?entityType=contact'),
    enabled: leContato,
  });
  const conversas = useQuery({
    queryKey: ['conversations', 'by-contact', contactId],
    queryFn: () =>
      api.get<ConversationPageDto>(
        // TODOS os estados: o padrão da rota é só as abertas
        `/api/conversations${toQuery({ contactId, status: 'all', limit: CONVERSAS_NA_FICHA })}`,
      ),
    enabled: leConversas,
  });
  const oportunidades = useQuery({
    queryKey: ['contact', contactId, 'deals'],
    queryFn: () => api.get<DealDto[]>(`/api/contacts/${contactId}/deals`),
    enabled: leOportunidades,
  });

  if (!leContato) return null;
  return (
    <section aria-label="Contato" className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-display-sm">Contato</h2>
        {/* a edição congela o contato como está na tela: só com ele carregado sem
            erro e sem releitura em andamento (a base não é um cache velho) */}
        {editaContato && contato.data && !contato.isError && !contato.isFetching ? (
          <Button size="sm" variant="secondary" onClick={() => setEditando(true)}>
            Editar dados
          </Button>
        ) : null}
      </div>
      <Panel className="space-y-1 p-4 text-body-sm">
        {contato.isError ? (
          <p className="text-negative">Não foi possível carregar o contato.</p>
        ) : !contato.data ? (
          <p className="text-muted-fg">Carregando…</p>
        ) : (
          <>
            <p>
              <span className="text-muted-fg">Telefone: </span>
              {contato.data.phones.join(', ') || '—'}
            </p>
            <p>
              <span className="text-muted-fg">E-mail: </span>
              {contato.data.emails.join(', ') || '—'}
            </p>
            {contato.data.tags.length > 0 ? (
              <p className="flex flex-wrap items-center gap-1.5">
                <span className="text-muted-fg">Etiquetas: </span>
                {contato.data.tags.map((t) => (
                  <TagBadge key={t.id} name={t.name} color={t.color} />
                ))}
              </p>
            ) : null}
            <CamposPreenchidos
              valores={contato.data.customFields}
              definicoes={definicoes.data}
              falhou={definicoes.isError}
            />
          </>
        )}
      </Panel>

      <ConsentimentosDoContato contactId={contactId} />

      {leConversas ? (
        <div className="space-y-2">
          <h3 className="text-body-sm font-medium">Conversas</h3>
          {conversas.isError ? (
            <p className="text-data text-negative">Não foi possível carregar as conversas.</p>
          ) : conversas.data && conversas.data.items.length === 0 ? (
            <p className="text-data text-muted-fg">Nenhuma conversa com esta pessoa.</p>
          ) : (
            <ul className="space-y-1">
              {(conversas.data?.items ?? []).map((c) => (
                <li key={c.id} className="text-body-sm">
                  <Link to={`/inbox?c=${encodeURIComponent(c.id)}`} className="hover:underline">
                    {c.subject ?? 'Conversa'}
                  </Link>{' '}
                  <span className="text-data text-muted-fg">
                    · última mensagem {relativeStamp(c.lastMessageAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {conversas.data?.nextCursor ? (
            <p className="text-data text-muted-fg">
              As {CONVERSAS_NA_FICHA} mais recentes. As demais estão em Conversas.
            </p>
          ) : null}
        </div>
      ) : null}

      {leOportunidades ? (
        <div className="space-y-2">
          <h3 className="text-body-sm font-medium">Oportunidades</h3>
          {oportunidades.isError ? (
            <p className="text-data text-negative">Não foi possível carregar as oportunidades.</p>
          ) : oportunidades.data && oportunidades.data.length === 0 ? (
            <p className="text-data text-muted-fg">Nenhuma oportunidade com esta pessoa.</p>
          ) : (
            <ul className="space-y-1">
              {(oportunidades.data ?? []).map((d) => (
                <li key={d.id} className="text-body-sm">
                  {d.title}{' '}
                  <span className="num text-data text-muted-fg">
                    · {ESTADO_DA_OPORTUNIDADE[d.status]} · {formatCents(d.amountCents)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {oportunidades.data && oportunidades.data.length >= TETO_DAS_OPORTUNIDADES ? (
            <p className="text-data text-muted-fg">
              As {TETO_DAS_OPORTUNIDADES} mais recentes. As demais estão no Funil.
            </p>
          ) : null}
          <Link to="/pipeline" className="text-data text-accent hover:underline">
            Abrir o Funil
          </Link>
        </div>
      ) : null}
      <Drawer open={editando} onOpenChange={setEditando} title="Editar dados">
        {editando && contato.data ? (
          <DadosDoContato
            key={contactId}
            contato={contato.data}
            rotuloDoBotao="Salvar"
            onDone={() => setEditando(false)}
          />
        ) : null}
      </Drawer>
    </section>
  );
}

/** Os campos personalizados preenchidos, com o rótulo da definição. */
function CamposPreenchidos({
  valores,
  definicoes,
  falhou,
}: {
  valores: Record<string, unknown>;
  definicoes: CustomFieldDto[] | undefined;
  falhou: boolean;
}) {
  if (falhou) {
    return (
      <p className="text-data text-negative">Não foi possível carregar os campos personalizados.</p>
    );
  }
  if (!definicoes) return null;
  // só o que tem definição: uma chave que saiu das definições não vira campo
  const preenchidos = definicoes.filter((d) => {
    const v = Object.hasOwn(valores, d.key) ? valores[d.key] : undefined;
    return v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0);
  });
  return (
    <>
      {preenchidos.map((d) => {
        const v = valores[d.key];
        const texto = Array.isArray(v)
          ? v.join(', ')
          : typeof v === 'boolean'
            ? v
              ? 'Sim'
              : 'Não'
            : String(v);
        return (
          <p key={d.id}>
            <span className="text-muted-fg">{d.label}: </span>
            {texto}
          </p>
        );
      })}
    </>
  );
}
