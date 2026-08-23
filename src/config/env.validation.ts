import { plainToInstance, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUrl,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

/**
 * Environment validation — runs at bootstrap, before the HTTP server binds a port.
 *
 * The timing is the whole mechanism. An app that checks a variable the first time it is
 * needed has already bound its port, reported healthy, joined the load balancer, and served
 * real traffic before anyone discovers it is misconfigured — and the discovery arrives as a
 * 500 for whichever user happened to hit that code path first.
 *
 * Throwing here exits the process non-zero, which makes a rolling deployment halt and keep
 * the previous version serving. A silently degraded instance passes its health check and
 * quietly serves errors instead, which is strictly worse: nothing alerts, and the good
 * version is already gone.
 *
 * Note that these validate the *shape*, not merely presence. A variable that exists but
 * holds the wrong kind of value is the more interesting failure — see PORT and
 * DATABASE_PORT below, and STRIPE_SECRET_KEY's `sk_test_` check when M5 adds it.
 */

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

export class EnvironmentVariables {
  @IsEnum(NodeEnv, { message: 'NODE_ENV must be development, test or production' })
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  // ── Database ────────────────────────────────────────────────────────────────
  @IsString()
  @IsNotEmpty()
  DATABASE_HOST: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  DATABASE_PORT: number;

  @IsString()
  @IsNotEmpty()
  DATABASE_USER: string;

  @IsString()
  @IsNotEmpty()
  DATABASE_PASSWORD: string;

  @IsString()
  @IsNotEmpty()
  DATABASE_NAME: string;

  // ── Redis ───────────────────────────────────────────────────────────────────
  @IsString()
  @IsNotEmpty()
  REDIS_HOST: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  REDIS_PORT: number;

  // ── RabbitMQ ────────────────────────────────────────────────────────────────
  // Validated from M0 even though nothing connects to it until M6, so a typo surfaces at
  // boot rather than three weeks later inside a consumer nobody is watching.
  @Matches(/^amqps?:\/\/.+/, { message: 'RABBITMQ_URL must start with amqp:// or amqps://' })
  RABBITMQ_URL: string;

  // ── Auth (M1) ───────────────────────────────────────────────────────────────
  // Signs the access token. NOT the same as the frontend's NEXTAUTH_SECRET, which encrypts
  // NextAuth's own session cookie — two secrets, two systems. That separation is deliberate
  // defence in depth: leaking NEXTAUTH_SECRET lets an attacker forge a session cookie, but
  // not a valid access token, so the API still rejects them.
  //
  // Minimum length enforced because a short secret is brute-forceable offline: an attacker
  // with any token from your system can grind candidate secrets until one verifies, then mint
  // tokens for any user. 32 bytes of real entropy: `openssl rand -base64 32`.
  @IsString()
  @MinLength(32, { message: 'JWT_ACCESS_SECRET must be at least 32 characters' })
  JWT_ACCESS_SECRET: string;

  // Short by design. This value IS the blast radius of an XSS token theft (TR-DEC-002) —
  // the token is readable by client JS, so its lifetime bounds how long a stolen one works.
  @Matches(/^\d+[smhd]$/, { message: 'JWT_ACCESS_EXPIRES_IN must look like 15m, 1h, 7d' })
  JWT_ACCESS_EXPIRES_IN: string = '15m';

  // Refresh tokens are NOT JWTs — they are opaque random values, stored as SHA-256 hashes.
  // So there is no refresh signing secret to configure, only a lifetime. A fast hash is
  // correct here: the value is already high-entropy, so there is nothing to slow down, and
  // bcrypt would just burn CPU on every refresh. Slow hashes are for guessable secrets.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  JWT_REFRESH_EXPIRES_DAYS: number = 7;

  // TR-DEC-017. Seconds during which an already-rotated refresh token is still accepted,
  // instead of being treated as theft. Fixes the lost-response race AND the parallel-refresh
  // race in NextAuth's jwt callback. Kept short: within this window a stolen token works.
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(300)
  REFRESH_GRACE_SECONDS: number = 30;

  // bcrypt cost factor (TR-DEC-016). Powers of two: 12 ≈ 250ms on current hardware, which is
  // the standard 200–500ms budget. 10 is the old default and low now. Configurable so tests
  // can drop it — hashing at cost 12 in a test suite that creates users is minutes of CPU.
  @Type(() => Number)
  @IsInt()
  @Min(4)
  @Max(15)
  BCRYPT_COST: number = 12;

  // ── HTTP ────────────────────────────────────────────────────────────────────
  // An explicit origin, never a wildcard — a wildcard origin combined with credentials is
  // rejected by browsers anyway, and reaching for `*` to make a CORS error go away is how
  // people end up disabling the protection rather than configuring it.
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  @MinLength(1)
  CORS_ORIGIN: string;

  // ── Stripe (M5) ─────────────────────────────────────────────────────────────
  // Test mode only, enforced HERE rather than trusted by convention. Stripe's OWN prefix
  // tells you which mode a key belongs to (`sk_test_…` vs `sk_live_…`), so this is a shape
  // check, not a policy this app invents — a live key literally cannot pass validation and
  // reach this codebase, which is a stronger guarantee than a code comment saying "don't".
  @Matches(/^sk_test_/, {
    message: 'STRIPE_SECRET_KEY must be a TEST key (sk_test_…) — live keys are never used here',
  })
  STRIPE_SECRET_KEY: string;

  // Signs webhook payloads so `stripe.webhooks.constructEvent` can verify a request genuinely
  // came from Stripe. Per-endpoint in the Stripe dashboard (or printed by `stripe listen` in
  // development) — NOT the same secret as STRIPE_SECRET_KEY, and not reused across endpoints.
  @Matches(/^whsec_/, { message: 'STRIPE_WEBHOOK_SECRET must start with whsec_' })
  STRIPE_WEBHOOK_SECRET: string;

  // Where Stripe Checkout redirects the BROWSER after payment — the frontend, not this API.
  // Never trusted as proof of payment (`frontend/CLAUDE.md`: "the Stripe success page cannot
  // be trusted") — only the webhook decides that. This URL exists purely to land the user
  // somewhere that then asks the API for the real status.
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  STRIPE_SUCCESS_URL: string;

  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  STRIPE_CANCEL_URL: string;
}

export function validate(config: Record<string, unknown>): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    // Turns the string "3000" from process.env into the number 3000 before validation.
    enableImplicitConversion: true,
    // Keeps class defaults (NODE_ENV, PORT) when the variable is absent entirely.
    exposeDefaultValues: true,
  });

  const errors = validateSync(validated, {
    skipMissingProperties: false,
    whitelist: false,
  });

  if (errors.length > 0) {
    const details = errors
      .map((error) => {
        const constraints = Object.values(error.constraints ?? {}).join(', ');
        return `  - ${error.property}: ${constraints || 'invalid'}`;
      })
      .join('\n');

    throw new Error(
      `\nEnvironment validation failed. The application will not start.\n\n${details}\n\n` +
        `Compare your .env against .env.example — every key listed there is required.\n`,
    );
  }

  return validated;
}
