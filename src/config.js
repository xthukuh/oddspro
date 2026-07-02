import 'dotenv/config';
import { z } from 'zod';

// Environment schema - external data validated with zod (names match .env)
const EnvSchema = z.object({
    DB_HOST: z.string().default('127.0.0.1'),
    DB_PORT: z.coerce.number().int().positive().default(3306),
    DB_DATABASE: z.string().default('oddspro'),
    DB_USERNAME: z.string().default('root'),
    DB_PASSWORD: z.string().default(''),
    DB_CHARSET: z.string().default('utf8mb4'),
    DB_COLLATION: z.string().default('utf8mb4_unicode_ci'),
    X_APISPORTS_URL: z.string().url().default('https://v3.football.api-sports.io'),
    X_APISPORTS_KEY: z.string().min(1, 'X_APISPORTS_KEY is required (see .env.example)'),
    BETPAWA_BASE_URL: z.string().url().optional(),
    BETIKA_BASE_URL: z.string().url().optional(),
    APISPORTS_MIN_REMAINING: z.coerce.number().int().min(0).default(5),
    LINK_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.85),
    API_PORT: z.coerce.number().int().positive().default(3001),
});

export const config = EnvSchema.parse(process.env);
