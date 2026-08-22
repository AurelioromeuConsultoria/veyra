/**
 * CLI de provisionamento controlado de workspace (ADR-014).
 *
 * USO: pnpm --filter @veyra/api provision --name "Acme" --slug acme --owner-email dono@acme.com
 *
 * Vive em `src/cli` e roda COMPILADO, não por `tsx`: o esbuild elide o import de
 * classe usada apenas em posição de tipo, e é assim que as dependências do Nest
 * chegam ao construtor. O resultado era `UndefinedDependencyException` que, com
 * `logger: false`, ficava SILENCIOSA — parecia travamento no boot. Os outros
 * scripts administrativos seguem em `scripts/` porque falam com o Prisma direto,
 * sem injeção.
 *
 * Owner com conta existente → Membership Owner criada.
 * Owner sem conta → Invite Owner; o TOKEN é impresso UMA ÚNICA VEZ abaixo
 * (ajuste #3): entregue por canal seguro. Só o hash fica no banco; nada de
 * token em log de aplicação.
 */
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ProvisioningService } from '../workspaces/provisioning.service';

function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) {
    console.error('Uso: provision --name "Nome" --slug slug-unico --owner-email dono@empresa.com');
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const name = arg('name');
  const slug = arg('slug');
  const ownerEmail = arg('owner-email');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const provisioning = app.get(ProvisioningService);
    const result = await provisioning.provision({ name, slug, ownerEmail });

    console.log(`Workspace provisionado: ${result.workspaceId} (slug: ${slug})`);
    console.log('Roles de sistema semeados: Owner, Admin, Member, Guest.');
    if (result.owner === 'membership') {
      console.log(`Owner: conta existente ${ownerEmail} — membership ${result.membershipId}.`);
    } else {
      console.log(`Owner: ${ownerEmail} ainda não tem conta — convite Owner criado.`);
      console.log(`Expira em: ${result.expiresAt.toISOString()}`);
      console.log('');
      console.log('TOKEN DO CONVITE (exibido só agora; entregue por canal seguro):');
      console.log(result.inviteToken);
    }
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('Provisionamento falhou:', error?.message ?? error);
  process.exit(1);
});
