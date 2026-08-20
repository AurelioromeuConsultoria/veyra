/**
 * setupFile (roda em cada worker antes dos testes): aponta DATABASE_URL para o
 * banco de teste ANTES de qualquer construção de PrismaClient (que lê
 * process.env.DATABASE_URL no construtor).
 */
import { TEST_DATABASE_URL, assertIsTestDb } from './db-url';

assertIsTestDb();
process.env.DATABASE_URL = TEST_DATABASE_URL;
