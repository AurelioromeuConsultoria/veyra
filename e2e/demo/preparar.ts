/**
 * A preparação da PILHA DA DEMONSTRAÇÃO do E2E (ADR-048 adendo 12, item 3),
 * rodada pelo comando do próprio servidor, ANTES de a API subir: o Playwright
 * sobe os servidores antes do setup global, e o worker — ligado nesta pilha —
 * não pode nascer num banco que será recriado.
 *
 * Cada passo usa o procedimento administrativo da operação, compilado como
 * na imagem: a ativação do Clinics, o cadastro do canal (o token fictício pela
 * entrada padrão, cifrado como na operação), a CLI das finalidades, o
 * `templates:demo` e o `demo:carregar` (ADR-048 adendos 12 e 13). Por SQL, só
 * a base, como o setup do E2E: o catálogo de permissões, o workspace, os papéis
 * e o Owner. O consentimento é registrado pela tela, no cenário.
 */
import { Client } from 'pg';
import { WABA_DA_DEMONSTRACAO } from '../../apps/api/src/demo/catalogo-da-demonstracao';
import {
  CANAL_DEMO,
  E2E_DEMO_DATABASE_URL as URL_DEMO,
  FINALIDADES_DEMO,
  OWNER_DEMO,
} from '../env';
import {
  cli,
  criarWorkspace,
  migrar,
  porNaExperiencia,
  recriarBanco,
  semearCatalogo,
} from '../semeadura';

/** o par que liga o transporte e o catálogo falsos (`transporteSimulado`) */
const TRANSPORTE_SIMULADO = { META_TRANSPORT_MODE: 'fake', VEYRA_ENV: 'staging' };

const um = async (db: Client, sql: string, params: unknown[]) =>
  (await db.query<{ id: string }>(sql, params)).rows[0].id;

async function main(): Promise<void> {
  await recriarBanco(URL_DEMO);
  migrar(URL_DEMO);
  const db = new Client({ connectionString: URL_DEMO });
  await db.connect();
  try {
    await semearCatalogo(db);
    await criarWorkspace(db, 'demo', OWNER_DEMO);
    process.stdout.write(
      cli(
        'node',
        ['apps/api/dist/verticals/clinics/cli/clinics.js', 'enable', '--slug', 'demo'],
        URL_DEMO,
      ),
    );
    // a demonstração na experiência da clínica: fixture de teste (ADR-055,
    // adendo 2), o staging não passa por aqui
    await porNaExperiencia(db, 'demo', 'clinics');

    // o canal pela CLI compilada (ADR-037; F4.4c): o token fictício pela
    // entrada padrão, nunca na linha de comando, cifrado como na operação
    process.stdout.write(
      cli(
        'node',
        [
          'apps/api/dist/cli/channel-whatsapp.js',
          '--slug',
          'demo',
          '--phone-number-id',
          '000000000000011',
          '--waba',
          WABA_DA_DEMONSTRACAO,
          '--name',
          CANAL_DEMO,
          '--token-stdin',
        ],
        URL_DEMO,
        {},
        'token-ficticio-da-demonstracao',
      ),
    );
    for (const f of FINALIDADES_DEMO) {
      process.stdout.write(
        cli(
          'node',
          [
            'apps/api/dist/cli/consent-purpose.js',
            '--slug',
            'demo',
            '--key',
            f.key,
            '--category',
            'utility',
            '--description',
            f.description,
            '--fields',
            f.fields,
          ],
          URL_DEMO,
        ),
      );
    }
    const canal = await um(
      db,
      `SELECT c."id" FROM "Channel" c JOIN "Workspace" w ON w."id" = c."workspaceId"
        WHERE w."slug" = 'demo' AND c."name" = $1`,
      [CANAL_DEMO],
    );
    // os templates fictícios: cadastro e revisão pelos serviços, em nome do Owner
    process.stdout.write(
      cli(
        'node',
        [
          'apps/api/dist/cli/templates-demo.js',
          '--slug',
          'demo',
          '--channel',
          canal,
          '--reviewer',
          OWNER_DEMO,
        ],
        URL_DEMO,
        TRANSPORTE_SIMULADO,
      ),
    );
    // os dados clínicos fictícios pela carga da demonstração (F4.4c), em nome do Owner
    process.stdout.write(
      cli(
        'node',
        [
          'apps/api/dist/verticals/clinics/cli/demo-carregar.js',
          '--slug',
          'demo',
          '--actor',
          OWNER_DEMO,
        ],
        URL_DEMO,
        TRANSPORTE_SIMULADO,
      ),
    );
  } finally {
    await db.end();
  }
}

main().catch((erro) => {
  console.error('A preparação da pilha da demonstração falhou:', erro);
  process.exit(1);
});
