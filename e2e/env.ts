/**
 * Ambiente do E2E — banco e credenciais próprios, isolados do dev.
 * Trava: o nome do database PRECISA conter "e2e" (o global-setup DROPA o banco).
 */
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgresql://veyra:veyra_dev@localhost:5434/veyra_e2e';

export const E2E_API_PORT = 3011;
export const E2E_WEB_PORT = 5185;
export const E2E_WEB_ORIGIN = `http://localhost:${E2E_WEB_PORT}`;

export const E2E_PASSWORD = 'e2e-senha-123';
/** bcrypt cost 4 de E2E_PASSWORD — fixo para o seed não depender de bcrypt na raiz */
export const E2E_PASSWORD_HASH = '$2b$04$WSaFY7j1mTkj1Q19767CYuuesIpFF5oZn1UPoIiXL8xMxLPkqfOVe';
export const OWNER_A = 'owner-a@e2e.veyra';
export const OWNER_B = 'owner-b@e2e.veyra';

export function assertIsE2eDb(url = E2E_DATABASE_URL): string {
  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (!dbName.includes('e2e')) {
    throw new Error(
      `Recusando usar o banco "${dbName}" para E2E: o nome precisa conter "e2e" ` +
        `(o setup DROPA o banco). Ajuste E2E_DATABASE_URL.`,
    );
  }
  return dbName;
}
