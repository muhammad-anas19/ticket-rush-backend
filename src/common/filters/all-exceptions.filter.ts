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

const STATUS_TEXT: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'Bad request',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.NOT_FOUND]: 'Not found',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'Unprocessable entity',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Too many requests',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'Internal server error',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'Service unavailable',
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const request = ctx.getRequest();
    const path: string = httpAdapter.getRequestUrl(request) ?? 'unknown';

    const { status, message, errors, details } = this.normalise(exception);

    if (status >= Number(HttpStatus.INTERNAL_SERVER_ERROR)) {
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
      ...(details !== undefined ? { details } : {}),
    };

    httpAdapter.reply(ctx.getResponse(), body, status);
  }

  private normalise(exception: unknown): {
    status: number;
    message: string;
    errors?: string[];
    details?: unknown;
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();

      if (typeof response === 'string') {
        return { status, message: response };
      }

      if (typeof response === 'object' && response !== null) {
        const payload = response as { message?: unknown; error?: unknown };

        if (Array.isArray(payload.message)) {
          return {
            status,
            message: 'Validation failed',
            errors: payload.message.map(String),
          };
        }

        if (typeof payload.message === 'string') {
          return { status, message: payload.message };
        }

        if (typeof payload.error === 'string') {
          return { status, message: payload.error };
        }

        return {
          status,
          message: STATUS_TEXT[status] ?? exception.message,
          details: response,
        };
      }

      return { status, message: exception.message };
    }

    if (exception instanceof QueryFailedError) {
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
