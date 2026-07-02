import { config } from './src/config.js';

export default {
    client: 'mysql2',
    connection: {
        host: config.DB_HOST,
        port: config.DB_PORT,
        user: config.DB_USER,
        password: config.DB_PASSWORD,
        database: config.DB_NAME,
        charset: 'utf8mb4',
    },
    pool: { min: 0, max: 10 },
    migrations: {
        directory: './src/db/migrations',
    },
};
