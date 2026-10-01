import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';

@Catch(BadRequestException)
export class ValidationErrorFilter implements ExceptionFilter {
  catch(_exception: BadRequestException, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request =
      typeof http.getRequest === 'function'
        ? http.getRequest<{ originalUrl?: string; url?: string }>()
        : undefined;
    const path = (request?.originalUrl ?? request?.url ?? '').split('?')[0];
    const message =
      path.endsWith('/availability') || path.endsWith('/price')
        ? 'Dates are not valid.'
        : 'Search query is not valid.';
    response.status(400).json({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message,
    });
  }
}
