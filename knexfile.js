import { config } from './src/config.js';

// One warning per process, not per pooled connection.
let _warnedTimeout = false;

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
        min: config.DB_POOL_MIN,
        max: config.DB_POOL_MAX,
        // Never wait forever for a pool slot. DB_POOL_MAX is 3 on the live
        // host, so one stuck query used to mean every later caller hung on
        // acquire with no error and no timeout - the request just never
        // answered, and the collection pass behind it never ran.
        acquireTimeoutMillis: config.DB_ACQUIRE_TIMEOUT,
        // Per-connection session setup. The timezone SET is REQUIRED (stored
        // datetimes are EAT wall-clock, so session NOW() must match) and its
        // failure must fail the connection.
        //
        // The statement timeout is BEST EFFORT and deliberately cannot fail a
        // connection, because the variable differs by engine and getting it
        // wrong here would break every connection in the pool at once:
        //   MariaDB (what production runs) - max_statement_time, in SECONDS
        //   MySQL                          - max_execution_time, in MILLIseconds
        // Both bound SELECTs only, so neither can interrupt an in-flight write.
        // We try each and ignore the "unknown system variable" error from the
        // one that does not apply, warning once rather than per connection.
        afterCreate: (conn, done) => {
            conn.query("SET time_zone = '+03:00'", err => {
                if (err) return done(err, conn);
                const secs = config.DB_STATEMENT_TIMEOUT;
                if (!(secs > 0)) return done(null, conn);
                conn.query(`SET max_statement_time = ${secs}`, e1 => {
                    if (!e1) return done(null, conn);
                    conn.query(`SET max_execution_time = ${Math.round(secs * 1000)}`, e2 => {
                        if (e2 && !_warnedTimeout) {
                            _warnedTimeout = true;
                            console.warn('[db] statement timeout not applied: this server supports neither '
                                + `max_statement_time nor max_execution_time (${e2.message}). `
                                + 'A runaway query can hold a pool slot; DB_ACQUIRE_TIMEOUT still bounds waiters.');
                        }
                        done(null, conn);
                    });
                });
            });
        },
    },
    migrations: {
        directory: './src/db/migrations',
    },
};
