import type { PrismaService } from './prisma.service';

/**
 * O instante do RELÓGIO DO BANCO, para quem compara um dado com "agora" fora de
 * uma consulta, como o "vencido" dos retornos (ADR-049; ADR-048 adendo 7,
 * ajustes da F3.2). Uma leitura por operação: quem a usa lê uma vez e reusa.
 *
 * Exceção do §3.3 do CLAUDE.md e do §2 do SECURITY.md: `raw` com texto FIXO,
 * sem tabela, sem parâmetro e sem dado de tenant (o client protegido recusa SQL
 * cru). Um teste estático fixa este arquivo como o único com esse texto.
 *
 * FORA de transação: o `raw` usa outra conexão do pool. Dentro de um
 * `$transaction`, prenderia uma segunda conexão por pedido, e o instante não
 * seria o da transação (que já tem o seu `now()`).
 */
export async function agoraDoBanco(prisma: PrismaService): Promise<Date> {
  const [{ agora }] = await prisma.raw.$queryRaw<{ agora: Date }[]>`SELECT now() AS agora`;
  return agora;
}
