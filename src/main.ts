import 'reflect-metadata';

import { ClassSerializerInterceptor, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost, NestFactory, Reflector } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';
import { AppConfig } from './config/configuration';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create(AppModule, {
    // Preserves the unparsed request body alongside the parsed one, as `req.rawBody`.
    //
    // Enabled from M0 even though nothing needs it until M5, because it is a bootstrap-level
    // setting and retrofitting it means touching the application's entry point during a
    // payments module — exactly when you least want a surprise.
    //
    // Why it exists at all: Stripe signs the exact BYTES of the webhook body and sends an
    // HMAC in the Stripe-Signature header. Express's json() middleware parses the body into
    // an object and throws the original buffer away, and JSON.stringify(req.body) is not
    // byte-identical — key order, whitespace and unicode escaping can all differ, and one
    // differing byte produces a completely different HMAC. Without the raw bytes, signature
    // verification fails on every LEGITIMATE webhook, which is a maximally confusing failure
    // because the code looks right and Stripe's dashboard shows the event was delivered.
    rawBody: true,
  });

  const config = app.get(ConfigService<AppConfig, true>);
  const port = config.get('port', { infer: true });
  const corsOrigin = config.get('corsOrigin', { infer: true });
  const nodeEnv = config.get('nodeEnv', { infer: true });

  // Every route lives under /api except health checks, which ops tooling expects at
  // conventional unprefixed paths.
  //
  // Set now rather than later, deliberately. P1 added its prefix at phase 9 and lost an
  // evening to cookie Paths that had been scoped against the pre-prefix URL structure. The
  // equivalent trap here is M5: the real webhook URL is /api/webhooks/stripe, so
  // `stripe listen --forward-to` must point there, not at the build spec's /webhooks/stripe.
  //
  // Note the `{*path}` syntax rather than the older `(.*)`. Nest 11 moved to path-to-regexp
  // v8, which requires named wildcard parameters; `(.*)` still works via an auto-conversion
  // shim but logs a deprecation warning on every boot.
  app.setGlobalPrefix('api', { exclude: ['health', 'health/{*path}'] });

  // An explicit origin, never a wildcard. Note that CORS is enforced by the *browser*, not
  // by the server — it is a server-declared policy the browser chooses to obey. It protects
  // users from a malicious site making authenticated requests on their behalf; it is not a
  // firewall, and curl ignores it entirely.
  app.enableCors({
    origin: corsOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      // Strips properties that have no decorator in the DTO. Without it, a client can send
      // extra fields that reach your service untyped and unvalidated.
      whitelist: true,
      // Goes further: reject the request outright rather than silently dropping the extras.
      // A client sending `role: 'admin'` to an endpoint that doesn't accept it should get a
      // 400 telling them so, not a quiet success that ignored it.
      forbidNonWhitelisted: true,
      // Turns the plain object from JSON into an instance of the DTO class, so @Type()
      // conversions run and a query string "2" becomes the number 2.
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      // Don't echo the received value back in the error. It would put a submitted password
      // straight into an error response and, from there, into logs.
      disableErrorMessages: false,
      validationError: { target: false, value: false },
    }),
  );

  // Interceptor wraps successes; filter wraps throws. Same shape from both paths.
  //
  // ORDER: the first-registered interceptor is the OUTERMOST, so on the response path the LAST
  // one runs first. ClassSerializer therefore sees the handler's raw return value and strips
  // @Exclude()d fields, and only then does the envelope wrap the cleaned result. Reverse them
  // and ClassSerializer would be handed the envelope — a plain object with nothing to strip —
  // so `passwordHash` would sail straight through.
  //
  // ClassSerializerInterceptor is what makes `@Exclude()` on User.passwordHash effective
  // everywhere, BY CONSTRUCTION. The auth endpoints already return explicit DTOs with no hash
  // in them, so this is defence in depth: the day someone returns a `User` entity directly from
  // a new endpoint, the hash is still stripped rather than published.
  app.useGlobalInterceptors(
    new ResponseEnvelopeInterceptor(),
    new ClassSerializerInterceptor(app.get(Reflector)),
  );
  app.useGlobalFilters(new AllExceptionsFilter(app.get(HttpAdapterHost)));

  // Lets onApplicationShutdown hooks run on SIGTERM — without it the Redis socket keeps the
  // event loop alive and the container is eventually SIGKILLed instead of exiting cleanly.
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('TicketRush API')
    .setDescription(
      'Live event ticketing. Organisers publish events with limited inventory; attendees ' +
        'hold a ticket for 10 minutes and pay via Stripe.',
    )
    .setVersion('0.1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'access-token', // referenced by @ApiBearerAuth('access-token') from M1
    )
    .build();

  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig), {
    swaggerOptions: { persistAuthorization: true },
  });

  await app.listen(port);

  logger.log(`Environment  ${nodeEnv}`);
  logger.log(`API          http://localhost:${port}/api`);
  logger.log(`Swagger      http://localhost:${port}/docs`);
  logger.log(`Liveness     http://localhost:${port}/health/live`);
  logger.log(`Readiness    http://localhost:${port}/health/ready`);
  logger.log(`CORS origin  ${corsOrigin}`);
}

void bootstrap();
