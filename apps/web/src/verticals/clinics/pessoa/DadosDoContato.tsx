import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ContactDto } from '@veyra/contracts';
import { useState } from 'react';
import { Button } from '../../../components/ui/button';
import { Field, Input } from '../../../components/ui/input';
import { api, ApiError } from '../../../lib/api';

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

/**
 * O nome, os telefones e os e-mails do contato, pela API do Core (`POST` para
 * um novo, `PATCH` para um existente; `contacts:write`). É o que a clínica
 * precisa para conversar e registrar consentimento — o consentimento só usa um
 * número que esteja no cadastro. Etiquetas e campos personalizados ficam fora
 * desta tela (ADR-055, adendo 4).
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
  const [nome, setNome] = useState(contato?.name ?? '');
  const [telefones, setTelefones] = useState((contato?.phones ?? []).join('\n'));
  const [emails, setEmails] = useState((contato?.emails ?? []).join('\n'));
  const salvar = useMutation({
    mutationFn: () => {
      const listaDeTelefones = linhas(telefones);
      const listaDeEmails = linhas(emails);
      if (!contato) {
        return api.post<ContactDto>('/api/contacts', {
          name: nome.trim(),
          phones: listaDeTelefones,
          emails: listaDeEmails,
        });
      }
      // como o formulário do Core: só o que MUDOU vai. Reenviar a lista antiga
      // tiraria um número acrescentado por outra pessoa enquanto a tela estava
      // aberta — e tirar um número revoga o consentimento dele
      return api.patch<ContactDto>(`/api/contacts/${contato.id}`, {
        name: nome.trim(),
        ...(mesmoConjunto(listaDeTelefones, contato.phones) ? {} : { phones: listaDeTelefones }),
        ...(mesmoConjunto(listaDeEmails, contato.emails) ? {} : { emails: listaDeEmails }),
      });
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
        if (nome.trim()) salvar.mutate();
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
      {salvar.error ? (
        <p role="alert" className="text-data text-negative">
          {salvar.error instanceof ApiError ? salvar.error.message : 'Não foi possível salvar.'}
        </p>
      ) : null}
      <Button type="submit" variant="primary" disabled={!nome.trim() || salvar.isPending}>
        {salvar.isPending ? 'Salvando…' : rotuloDoBotao}
      </Button>
    </form>
  );
}
