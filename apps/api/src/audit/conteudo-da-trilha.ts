import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { AuditEntryDto } from '@veyra/contracts';
import type { AuthContext } from '../common/decorators';
import { CONTEUDO_RESTRITO, ProtectedContentService } from '../extensions/protected-content';
import { FilesService } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';

/** Os campos da trilha que carregam conteúdo protegido, por entidade (ADR-061, adendo 7). */
const CAMPO_PROTEGIDO: Readonly<Record<string, string>> = {
  deal: 'title',
  task: 'title',
  file: 'fileName',
};

/**
 * A LEITURA da trilha sob o E8 (ADR-061, adendo 7): o título da oportunidade
 * ou da tarefa e o nome do arquivo saem como "Conteúdo restrito" quando a
 * entidade é oculta para quem lê — pela mesma regra das telas (a oportunidade
 * pelo contato atual, a tarefa pelo alvo atual, o arquivo pela mídia
 * protegida). A entidade que não existe mais é tratada na dúvida
 * (conservador). No modo livre, ou sem a extensão, a trilha sai como sempre.
 * A gravação não muda: a trilha continua íntegra para quem pode lê-la.
 */
@Injectable()
export class ConteudoDaTrilha {
  constructor(
    private readonly prisma: PrismaService,
    private readonly protegido: ProtectedContentService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async mascarar(auth: AuthContext, itens: AuditEntryDto[]): Promise<AuditEntryDto[]> {
    const comCampo = itens.filter((i) => {
      const campo = CAMPO_PROTEGIDO[i.entityType];
      return campo !== undefined && (campo in (i.before ?? {}) || campo in (i.after ?? {}));
    });
    if (comCampo.length === 0 || !(await this.protegido.duvidaOculta(auth))) return itens;
    const ids = (tipo: string) => [
      ...new Set(comCampo.filter((i) => i.entityType === tipo).map((i) => i.entityId)),
    ];
    // a oportunidade: o título oculto pelo contato de agora (ou apagada) ou por
    // ter sido dado enquanto ela era de um contato oculto — valor a valor
    const titulos = await this.protegido.titulosDeOportunidadeOcultos(auth, ids('deal'));
    const ocultas = new Set<string>([
      ...(await this.tarefas(auth, ids('task'))),
      ...(await this.arquivos(auth, ids('file'))),
    ]);
    // a tarefa que uma automação ou a IA criou sobre conteúdo oculto: a linha
    // inteira sai — a existência dela diria que a automação executou (adendo 7)
    const visiveis = itens.filter(
      (i) => !(i.action.startsWith('task.created_by_') && ocultas.has(`task:${i.entityId}`)),
    );
    return visiveis.map((i) => {
      const campo = CAMPO_PROTEGIDO[i.entityType];
      if (!campo) return i;
      const oculto = (valor: unknown): boolean => {
        if (i.entityType === 'deal') {
          const t = titulos.get(i.entityId);
          return !!t && (t.todos || (typeof valor === 'string' && t.titulos.has(valor)));
        }
        return ocultas.has(`${i.entityType}:${i.entityId}`);
      };
      const tapar = (lado: Record<string, unknown> | null) =>
        lado && campo in lado && oculto(lado[campo])
          ? { ...lado, [campo]: CONTEUDO_RESTRITO }
          : lado;
      return { ...i, before: tapar(i.before), after: tapar(i.after) };
    });
  }

  private async tarefas(auth: AuthContext, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const linhas = (await this.prisma.db.task.findMany({
      where: { id: { in: ids } },
      select: { id: true, contactId: true, dealId: true },
    } as never)) as unknown as { id: string; contactId: string | null; dealId: string | null }[];
    const porId = new Map(linhas.map((l) => [l.id, l]));
    // o alvo de AGORA e os do passado (as atividades gravam o contato do
    // momento): a tarefa que saiu de um contato protegido não devolve o título dela
    const historico = (await this.prisma.db.activity.findMany({
      where: { taskId: { in: ids }, contactId: { not: null } },
      select: { taskId: true, contactId: true },
    } as never)) as unknown as { taskId: string; contactId: string }[];
    const ocultosDoPassado = await this.protegido.contatosOcultos(
      auth,
      historico.map((h) => h.contactId),
    );
    const fora: string[] = [];
    for (const id of ids) {
      const linha = porId.get(id);
      const doPassado = historico.some((h) => h.taskId === id && ocultosDoPassado.has(h.contactId));
      if (!linha || doPassado || (await this.protegido.alvoOculto(auth, linha))) {
        fora.push(`task:${id}`);
      }
    }
    return fora;
  }

  private async arquivos(auth: AuthContext, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const existem = new Set(
      (
        (await this.prisma.db.fileObject.findMany({
          where: { id: { in: ids } },
          select: { id: true },
        } as never)) as unknown as { id: string }[]
      ).map((r) => r.id),
    );
    // resolvido na hora: o módulo de arquivos depende da auditoria
    const files = this.moduleRef.get(FilesService, { strict: false });
    const protegidas = await files.midiaProtegida(auth, [...existem]);
    return ids.filter((id) => !existem.has(id) || protegidas.has(id)).map((id) => `file:${id}`);
  }
}
