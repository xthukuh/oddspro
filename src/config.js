import 'dotenv/config';
import { z } from 'zod';

// Environment schema - external data validated with zod
const EnvSchema = z.object({
    DB_HOST: z.string().default('127.0.0.1'),
    DB_PORT: z.coerce.number().int().positive().default(3306),
    DB_USER: z.string().default('root'),
    DB_PASSWORD: z.string().default(''),
    DB_NAME: z.string().default('oddspro'),
    X_APISPORTS_URL: z.string().url().default('https://v3.football.api-sports.io'),
    X_APISPORTS_KEY: z.string().min(1, 'X_APISPORTS_KEY is required (see .env.example)'),
    BETPAWA_BASE_URL: z.string().url().optional(),
    BETIKA_BASE_URL: z.string().url().optional(),
    APISPORTS_MIN_REMAINING: z.coerce.number().int().min(0).default(5),
});

export const config = EnvSchema.parse(process.env);
