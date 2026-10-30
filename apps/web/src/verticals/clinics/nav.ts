/**
 * Os caminhos do Clinics. O menu da experiência da clínica está no manifesto
 * (`experience.tsx`), organizado pelo trabalho da clínica (ADR-055, adendo 3).
 */
export const CLINICS_TODAY_PATH = '/clinics/today';
export const CLINICS_AGENDA_PATH = '/clinics/agenda';
export const CLINICS_PATIENTS_PATH = '/clinics/patients';
/**
 * A ficha de um paciente (F3.3b): fora da navegação, aberta pela lista, com o
 * id na query (`?id=`). As rotas de vertical são estáticas (composition.test).
 */
export const CLINICS_PATIENT_PATH = '/clinics/patient';

/** O caminho da ficha de um paciente. */
export const fichaDoPaciente = (id: string) =>
  `${CLINICS_PATIENT_PATH}?id=${encodeURIComponent(id)}`;
export const CLINICS_RETURNS_PATH = '/clinics/returns';
export const CLINICS_NO_SHOW_PATH = '/clinics/no-show';
export const CLINICS_CATALOG_PATH = '/clinics/catalog';
export const CLINICS_AI_RELEASES_PATH = '/clinics/ai-releases';
export const CLINICS_OUTREACH_PATH = '/clinics/outreach';
export const CLINICS_OUTREACH_METRICS_PATH = '/clinics/outreach-metrics';
export const CLINICS_LEADS_PATH = '/clinics/leads';
/**
 * A pessoa (ADR-055, adendos 3 e 4): o destino único de um contato na clínica.
 * Ela decide pela permissão de quem abre — a ficha, se for paciente e a pessoa
 * puder saber; senão, o contato, sem dizer se é paciente.
 */
export const CLINICS_PERSON_PATH = '/clinics/person';

/** O caminho da pessoa de um contato. */
export const pessoaDoContato = (contactId: string) =>
  `${CLINICS_PERSON_PATH}?id=${encodeURIComponent(contactId)}`;
