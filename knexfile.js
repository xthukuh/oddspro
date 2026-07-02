import { config } from './src/config.js';

export default {
    client: 'mysql2',
    connection: {
        host: config.DB_HOST,
        port: config.DB_PORT,
        user: config.DB_USERNAME,
        password: config.DB_PASSWORD,
        database: config.DB_DATABASE,
        charset: config.DB_CHARSET,
    },
    pool: {
        min: 0,
        max: 10,
        // Stored datetimes are EAT wall-clock; align session NOW() to match.
        afterCreate: (conn, done) => conn.query("SET time_zone = '+03:00'", err => done(err, conn)),
    },
    migrations: {
        directory: './src/db/migrations',
    },
};
