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
    rawBody: true,
  });

  const config = app.get(ConfigService<AppConfig, true>);
  const port = config.get('port', { infer: true });
  const corsOrigin = config.get('corsOrigin', { infer: true });
  const nodeEnv = config.get('nodeEnv', { infer: true });

  app.setGlobalPrefix('api', { exclude: ['health', 'health/{*path}'] });

  app.enableCors({
    origin: corsOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      disableErrorMessages: false,
      validationError: { target: false, value: false },
    }),
  );

  app.useGlobalInterceptors(
    new ResponseEnvelopeInterceptor(),
    new ClassSerializerInterceptor(app.get(Reflector)),
  );
  app.useGlobalFilters(new AllExceptionsFilter(app.get(HttpAdapterHost)));

  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('TicketRush API')
    .setDescription(
      'Live event ticketing. Organisers publish events with limited inventory; attendees ' +
        'hold a ticket for 10 minutes and pay via Stripe.',
    )
    .setVersion('0.1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
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
