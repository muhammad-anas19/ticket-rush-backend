import { NodeEnv } from './env.validation';

export interface AppConfig {
  nodeEnv: NodeEnv;
  isProduction: boolean;
  port: number;
  corsOrigin: string;
  database: {
    host: string;
    port: number;
    username: string;
    password: string;
    name: string;
  };
  redis: {
    host: string;
    port: number;
  };
  rabbitmq: {
    url: string;
  };
  auth: {
    accessSecret: string;
    accessExpiresIn: string;
    refreshExpiresDays: number;
    refreshGraceSeconds: number;
    bcryptCost: number;
  };
  stripe: {
    secretKey: string;
    webhookSecret: string;
    successUrl: string;
    cancelUrl: string;
  };
}

export default (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV as NodeEnv,
  isProduction: process.env.NODE_ENV === NodeEnv.Production,
  port: parseInt(process.env.PORT ?? '3000', 10),
  corsOrigin: process.env.CORS_ORIGIN!,
  database: {
    host: process.env.DATABASE_HOST!,
    port: parseInt(process.env.DATABASE_PORT!, 10),
    username: process.env.DATABASE_USER!,
    password: process.env.DATABASE_PASSWORD!,
    name: process.env.DATABASE_NAME!,
  },
  redis: {
    host: process.env.REDIS_HOST!,
    port: parseInt(process.env.REDIS_PORT!, 10),
  },
  rabbitmq: {
    url: process.env.RABBITMQ_URL!,
  },
  auth: {
    accessSecret: process.env.JWT_ACCESS_SECRET!,
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '15m',
    refreshExpiresDays: parseInt(process.env.JWT_REFRESH_EXPIRES_DAYS ?? '7', 10),
    refreshGraceSeconds: parseInt(process.env.REFRESH_GRACE_SECONDS ?? '30', 10),
    bcryptCost: parseInt(process.env.BCRYPT_COST ?? '12', 10),
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY!,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
    successUrl: process.env.STRIPE_SUCCESS_URL!,
    cancelUrl: process.env.STRIPE_CANCEL_URL!,
  },
});
