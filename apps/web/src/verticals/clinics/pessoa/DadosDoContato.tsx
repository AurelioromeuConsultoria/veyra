import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ContactDto, CustomFieldDto, TagDto } from '@veyra/contracts';
import { useState } from 'react';
import { CustomFieldInput, SeletorDeEtiquetas } from '../../../components/contacts/CamposDoContato';
import { Button } from '../../../components/ui/button';
import { Field, Input } from '../../../components/ui/input';
import { api, ApiError } from '../../../lib/api';
import { alcanca, useSession } from '../../../lib/session';

const linhas = (texto: string) =>
  texto
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** A mesma lista, em qualquer ordem: o que não mudou não é reenviado. */
function mesmoConjunto(a: string[], b: string[]): boolean {
  const outro = new Set(b);
  return a.length === b.length && a.every((v) => outro.has(v));
}

const vazio = (valor: unknown) => valor === undefined || valor === null;
/** O valor de uma chave do PRÓPRIO objeto (uma chave como `constructor` não vem do protótipo). */
const valorDe = (fonte: Record<string, unknown> | undefined, chave: string) =>
  fonte && Object.hasOwn(fonte, chave) ? fonte[chave] : undefined;
const igual = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Os dados do contato na clínica, pela API do Core (`POST` para um novo,
 * `PATCH` para um existente; `contacts:write`): nome, telefones, e-mails,
 * etiquetas e campos personalizados (ADR-055, adendos 4 e 5). Os componentes,
 * as definições e a validação são os do Core — não há cadastro de campos da
 * clínica, e isto é informação de contato, não prontuário.
 *
 * Só o que foi EDITADO é enviado, comparado com o contato COMO A TELA ABRIU (a
 * base é congelada: a consulta relida, quando a rede volta, não muda o que conta
 * como editado): o nome, as listas e o conjunto de etiquetas só quando mudaram,
 * e os campos personalizados por chave (o `PATCH` substitui só as chaves
 * enviadas). Assim, o que esta tela não mexeu continua como está — inclusive o
 * que outra pessoa gravou enquanto ela estava aberta. Duas edições do MESMO item
 * (a mesma chave, a lista de telefones ou de e-mails, o conjunto de etiquetas) a
 * partir de telas desatualizadas: vale a última (o Core não tem versão otimista).
 */
export function DadosDoContato({
  contato,
  rotuloDoBotao,
  onDone,
}: {
  /** ausente = um contato novo (ele chega como interessado, sem ficha) */
  contato?: ContactDto;
  rotuloDoBotao: string;
  onDone: (contato: ContactDto) => void;
}) {
  const queryClient = useQueryClient();
  const { data: user } = useSession();
  const leContato = alcanca(user, { permission: 'contacts:read' });
  const definicoes = useQuery({
    queryKey: ['custom-fields', 'contact'],
    queryFn: () => api.get<CustomFieldDto[]>('/api/custom-fields?entityType=contact'),
    enabled: leContato,
  });
  const etiquetas = useQuery({
    queryKey: ['tags'],
    queryFn: () => api.get<TagDto[]>('/api/tags'),
    enabled: leContato,
  });
  // o que a tela mostra e o que ela envia usam a MESMA condição: com erro, não há
  // lista — nem a que ficou no cache de uma carga anterior
  const defs = definicoes.isError ? undefined : definicoes.data;
  const listaDeEtiquetas = etiquetas.isError ? undefined : etiquetas.data;

  // a base da comparação: o contato como a tela abriu, congelado
  const [base] = useState(contato);
  const etiquetasDaBase = base?.tags.map((t) => t.id) ?? [];
  const [nome, setNome] = useState(base?.name ?? '');
  const [telefones, setTelefones] = useState((base?.phones ?? []).join('\n'));
  const [emails, setEmails] = useState((base?.emails ?? []).join('\n'));
  const [tagIds, setTagIds] = useState<string[]>(etiquetasDaBase);
  const [valores, setValores] = useState<Record<string, unknown>>({
    ...(base?.customFields ?? {}),
  });
  const [tentou, setTentou] = useState(false);

  // a mesma regra do servidor: criar exige todos os obrigatórios; editar só não
  // pode LIMPAR um que tinha valor (um contato antigo sem o campo continua editável)
  const faltam = (lista: CustomFieldDto[]) =>
    lista.filter(
      (d) =>
        d.required &&
        vazio(valorDe(valores, d.key)) &&
        (!base || !vazio(valorDe(base.customFields, d.key))),
    );
  // recalculado a cada mudança: o aviso some quando o campo é preenchido
  const faltando = tentou && defs ? faltam(defs).map((d) => d.label) : [];

  const salvar = useMutation({
    mutationFn: (lista: CustomFieldDto[]) => {
      const listaDeTelefones = linhas(telefones);
      const listaDeEmails = linhas(emails);
      if (!base) {
        const preenchidos = Object.fromEntries(
          lista
            .filter((d) => !vazio(valorDe(valores, d.key)))
            .map((d) => [d.key, valorDe(valores, d.key)]),
        );
        return api.post<ContactDto>('/api/contacts', {
          name: nome.trim(),
          phones: listaDeTelefones,
          emails: listaDeEmails,
          ...(listaDeEtiquetas && tagIds.length > 0 ? { tagIds } : {}),
          ...(Object.keys(preenchidos).length > 0 ? { customFields: preenchidos } : {}),
        });
      }
      // como o formulário do Core faz com telefones e e-mails: só o que MUDOU
      // vai (aqui também as etiquetas e os campos). Reenviar a lista antiga
      // tiraria um número acrescentado por outra pessoa enquanto a tela estava
      // aberta — e tirar um número revoga o consentimento dele
      const alterados = Object.fromEntries(
        lista
          .filter((d) => !igual(valorDe(valores, d.key), valorDe(base.customFields, d.key)))
          .map((d) => [d.key, valorDe(valores, d.key) ?? null]),
      );
      const mudancas = {
        ...(nome.trim() !== base.name ? { name: nome.trim() } : {}),
        ...(mesmoConjunto(listaDeTelefones, base.phones) ? {} : { phones: listaDeTelefones }),
        ...(mesmoConjunto(listaDeEmails, base.emails) ? {} : { emails: listaDeEmails }),
        // o conjunto de etiquetas é gravado inteiro: só vai quando mudou, e só
        // com a lista delas carregada
        ...(listaDeEtiquetas && !mesmoConjunto(tagIds, etiquetasDaBase) ? { tagIds } : {}),
        ...(Object.keys(alterados).length > 0 ? { customFields: alterados } : {}),
      };
      // nada mudou: nenhuma gravação (a tela só relê o que já tinha)
      if (Object.keys(mudancas).length === 0) return Promise.resolve(base);
      return api.patch<ContactDto>(`/api/contacts/${base.id}`, mudancas);
    },
    onSuccess: (salvo) => {
      void queryClient.invalidateQueries({ queryKey: ['contact', salvo.id] });
      void queryClient.invalidateQueries({ queryKey: ['clinics', 'leads'] });
      void queryClient.invalidateQueries({ queryKey: ['consents', 'contact', salvo.id] });
      // o nome também está na ficha (o cabeçalho) e na busca
      void queryClient.invalidateQueries({ queryKey: ['clinics', 'patients'] });
      void queryClient.invalidateQueries({ queryKey: ['global-search'] });
      onDone(salvo);
    },
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        // sem as definições, não se sabe quais são obrigatórias: nada é enviado
        if (!nome.trim() || !defs) return;
        setTentou(true);
        if (faltam(defs).length === 0) salvar.mutate(defs);
      }}
    >
      <Field label="Nome">
        <Input autoFocus maxLength={160} value={nome} onChange={(e) => setNome(e.target.value)} />
      </Field>
      <Field label="Telefones" hint="Um por linha, com o código do país (+55…).">
        <textarea
          aria-label="Telefones"
          rows={2}
          value={telefones}
          onChange={(e) => setTelefones(e.target.value)}
          className="w-full rounded-control border border-border bg-surface px-3 py-2 text-body-sm"
        />
      </Field>
      <Field label="E-mails" hint="Um por linha.">
        <textarea
          aria-label="E-mails"
          rows={2}
          value={emails}
          onChange={(e) => setEmails(e.target.value)}
          className="w-full rounded-control border border-border bg-surface px-3 py-2 text-body-sm"
        />
      </Field>

      {etiquetas.isError ? (
        <p className="text-data text-muted-fg">
          Não foi possível carregar as etiquetas: elas ficam como estão.
        </p>
      ) : listaDeEtiquetas ? (
        <SeletorDeEtiquetas
          titulo="Etiquetas"
          tags={listaDeEtiquetas}
          selecionadas={tagIds}
          disabled={false}
          onChange={setTagIds}
        />
      ) : null}

      {definicoes.isError ? (
        <div role="alert" className="space-y-2 text-data text-negative">
          <p>
            Não foi possível carregar os campos personalizados. Sem eles, não dá para saber quais
            são obrigatórios: nada é salvo até carregarem.
          </p>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => void definicoes.refetch()}
          >
            Tentar de novo
          </Button>
        </div>
      ) : !defs ? (
        <p className="text-data text-muted-fg">Carregando os campos personalizados…</p>
      ) : (
        defs.map((def) => (
          <CustomFieldInput
            key={def.id}
            def={def}
            value={valorDe(valores, def.key)}
            disabled={false}
            onChange={(valor) => setValores((v) => ({ ...v, [def.key]: valor }))}
          />
        ))
      )}

      {faltando.length > 0 ? (
        <p role="alert" className="text-data text-negative">
          Preencha os campos obrigatórios: {faltando.join(', ')}.
        </p>
      ) : null}
      {salvar.error ? (
        <p role="alert" className="text-data text-negative">
          {salvar.error instanceof ApiError ? salvar.error.message : 'Não foi possível salvar.'}
        </p>
      ) : null}
      <Button type="submit" variant="primary" disabled={!nome.trim() || salvar.isPending || !defs}>
        {salvar.isPending ? 'Salvando…' : rotuloDoBotao}
      </Button>
    </form>
  );
}
