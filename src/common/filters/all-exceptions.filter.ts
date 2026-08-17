import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { QueryFailedError } from 'typeorm';

import { ApiErrorEnvelope } from '../types/api-envelope';

/**
 * Normalises every thrown error into one response shape.
 *
 * `@Catch()` with no argument catches everything — Nest's own HttpExceptions, TypeORM
 * errors, and plain unexpected throws from anywhere in the request pipeline. Without it, a
 * `TypeError` in a service reaches the client as Nest's default 500 body, which is a
 * different shape from every other error the frontend handles.
 *
 * The security rule this enforces: **internals never reach the client.** A raw Postgres
 * error message leaks table and column names; a stack trace leaks file paths and library
 * versions. Both are free reconnaissance. Log the detail server-side, return something
 * generic — in every environment reachable by real traffic, not just production.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  // Injected rather than importing express types directly, so this filter still works if
  // the platform is ever swapped to Fastify.
  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const request = ctx.getRequest();
    const path: string = httpAdapter.getRequestUrl(request) ?? 'unknown';

    const { status, message, errors } = this.normalise(exception);

    // `Number(...)` because `status` is a plain number while HttpStatus is an enum, and
    // comparing the two trips no-unsafe-enum-comparison. The rule is right to complain:
    // enum-vs-number comparisons are where accidental cross-enum bugs hide.
    if (status >= Number(HttpStatus.INTERNAL_SERVER_ERROR)) {
      // Full detail, server-side only. This is the copy that has to be useful at 3am.
      this.logger.error(
        `${status} ${path} — ${message}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(`${status} ${path} — ${message}`);
    }

    const body: ApiErrorEnvelope = {
      success: false,
      data: null,
      message,
      statusCode: status,
      path,
      timestamp: new Date().toISOString(),
      ...(errors ? { errors } : {}),
    };

    httpAdapter.reply(ctx.getResponse(), body, status);
  }

  private normalise(exception: unknown): {
    status: number;
    message: string;
    errors?: string[];
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();

      // The global ValidationPipe throws a BadRequestException whose response body has a
      // `message` array — one entry per failed constraint. Those are surfaced as-is:
      // "email must be an email" helps the legitimate caller and leaks nothing about system
      // state. Contrast with auth failures, which stay deliberately generic.
      if (typeof response === 'object' && response !== null) {
        const payload = response as { message?: string | string[]; error?: string };
        if (Array.isArray(payload.message)) {
          return { status, message: 'Validation failed', errors: payload.message };
        }
        return { status, message: payload.message ?? payload.error ?? exception.message };
      }

      return { status, message: typeof response === 'string' ? response : exception.message };
    }

    if (exception instanceof QueryFailedError) {
      // A database error means a bug in our SQL or a constraint we should have checked.
      // The driver's message names tables, columns and constraints — useful in a log,
      // reconnaissance in a response body.
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'A database error occurred',
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    };
  }
}
