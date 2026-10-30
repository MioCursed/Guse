import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, "Discord Token is required"),
  CLIENT_ID: z.string().min(1, "Client ID is required"),
  DISCORD_INVITE_CHANNEL_ID: z.string().regex(/^\d{17,20}$/, "Discord invite channel ID must be a snowflake").default("1484265142320365638"),
  DISCORD_CLIENT_SECRET: z.preprocess(
    value => value === '' ? undefined : value,
    z.string().min(1, "Discord OAuth client secret cannot be empty").optional()
  ),
  SESSION_SECRET: z.string().min(32, "Session secret must be at least 32 characters"),
  PORT: z.string().default("3000"),
  PUBLIC_URL: z.string().url().default("http://localhost:3000"),
  STUN_URLS: z.string().default("stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302"),
  TURN_URLS: z.string().default(""),
  TURN_SHARED_SECRET: z.string().optional(),
  SCREEN_DOMAIN: z.preprocess(
    value => value === '' ? undefined : value,
    z.string().url().optional()
  ),
}).superRefine((config, context) => {
  if (config.TURN_URLS && !config.TURN_SHARED_SECRET) {
    context.addIssue({
      code: 'custom',
      path: ['TURN_SHARED_SECRET'],
      message: 'TURN_SHARED_SECRET is required when TURN_URLS is configured'
    });
  }
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error("❌ Invalid environment variables:", _env.error.format());
  process.exit(1);
}

export const env = _env.data;
