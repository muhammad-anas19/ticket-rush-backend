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

  @IsString()
  @IsNotEmpty()
  REDIS_HOST: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  REDIS_PORT: number;

  @Matches(/^amqps?:\/\/.+/, { message: 'RABBITMQ_URL must start with amqp:// or amqps://' })
  RABBITMQ_URL: string;

  @IsString()
  @MinLength(32, { message: 'JWT_ACCESS_SECRET must be at least 32 characters' })
  JWT_ACCESS_SECRET: string;

  @Matches(/^\d+[smhd]$/, { message: 'JWT_ACCESS_EXPIRES_IN must look like 15m, 1h, 7d' })
  JWT_ACCESS_EXPIRES_IN: string = '15m';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  JWT_REFRESH_EXPIRES_DAYS: number = 7;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(300)
  REFRESH_GRACE_SECONDS: number = 30;

  @Type(() => Number)
  @IsInt()
  @Min(4)
  @Max(15)
  BCRYPT_COST: number = 12;

  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  @MinLength(1)
  CORS_ORIGIN: string;

  @Matches(/^sk_test_/, {
    message: 'STRIPE_SECRET_KEY must be a TEST key (sk_test_…) — live keys are never used here',
  })
  STRIPE_SECRET_KEY: string;

  @Matches(/^whsec_/, { message: 'STRIPE_WEBHOOK_SECRET must start with whsec_' })
  STRIPE_WEBHOOK_SECRET: string;

  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  STRIPE_SUCCESS_URL: string;

  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  STRIPE_CANCEL_URL: string;
}

export function validate(config: Record<string, unknown>): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
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
