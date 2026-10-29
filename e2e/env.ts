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
/** Workspace `clinica`: o único com o Veyra Clinics ATIVO no e2e (dados fictícios). */
export const OWNER_C = 'owner-c@e2e.veyra';
export const MEMBER_C = 'recepcao-c@e2e.veyra';
/** papel `Profissional` do Clinics (criado pela ativação) — lê a agenda e registra atendimento */
export const PROF_C = 'profissional-c@e2e.veyra';

/**
 * A PILHA DA DEMONSTRAÇÃO (ADR-048 adendo 12, item 3): o transporte e o
 * catálogo falsos, os jobs ligados e um banco próprio (`veyra_e2e_demo`, no
 * mesmo servidor do E2E), recriado e preparado pelos procedimentos
 * administrativos antes de a API subir. Dados fictícios.
 */
export const E2E_DEMO_DATABASE_URL = (() => {
  const url = new URL(E2E_DATABASE_URL);
  url.pathname = '/veyra_e2e_demo';
  return url.toString();
})();
export const E2E_DEMO_API_PORT = 3012;
export const E2E_DEMO_WEB_PORT = 5186;
export const E2E_DEMO_WEB_ORIGIN = `http://localhost:${E2E_DEMO_WEB_PORT}`;
/** o Owner do workspace `demo`, que também revisa os templates fictícios */
export const OWNER_DEMO = 'owner-demo@e2e.veyra';
/**
 * A paciente fictícia da demonstração que o cenário usa, criada pelo
 * `demo:carregar` (o primeiro paciente da carga), e o número dela, de prefixo
 * fictício
 */
export const PACIENTE_DEMO = 'Carla Demonstração';
export const NUMERO_DEMO = '+5511900000201';
export const CANAL_DEMO = 'WhatsApp da demonstração';
/** as finalidades dos templates fictícios, criadas pela CLI `consents:purpose` */
export const FINALIDADES_DEMO = [
  {
    key: 'clinics_confirmacao',
    description: 'Lembretes e confirmação dos seus horários na clínica (demonstração)',
    fields: 'contato.primeiro_nome,clinics.data,clinics.hora',
  },
  {
    key: 'clinics_reativacao',
    description: 'Aviso de retorno pendente na clínica (demonstração)',
    fields: 'contato.primeiro_nome',
  },
  {
    key: 'atendimento_retomada',
    description: 'Retomar o seu atendimento por mensagem (demonstração)',
    fields: 'contato.nome',
  },
] as const;

/** As chaves do E2E, as mesmas nas duas pilhas: nunca as de outro ambiente. */
export const E2E_CHAVES = {
  JWT_SECRET: 'jwt-secret-de-e2e-nunca-em-producao-32ch',
  TOKEN_ENCRYPTION_KEY: 'chave-de-cifra-de-e2e-nunca-em-producao-32',
  ADDRESS_LOCK_KEY: 'chave-das-travas-de-endereco-de-e2e-32ch',
  OUTBOUND_APPROVAL_KEY: 'chave-da-aprovacao-do-envio-de-e2e-32ch',
} as const;

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
