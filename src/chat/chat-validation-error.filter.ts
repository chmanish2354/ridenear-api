import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';

@Catch(BadRequestException)
export class ChatValidationErrorFilter implements ExceptionFilter {
  catch(_exception: BadRequestException, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    response.status(400).json({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Chat turn is not valid.',
    });
  }
}
