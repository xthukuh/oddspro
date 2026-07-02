import knex from 'knex';
import knexConfig from '../../knexfile.js';

// Single shared knex instance - all queries go through this (never raw mysql2).
export const db = knex(knexConfig);

// Close the pool so CLI actions can exit cleanly.
export async function closeDb() {
    await db.destroy();
}
