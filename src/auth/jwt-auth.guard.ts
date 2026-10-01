import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from './public.decorator.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'UNAUTHORIZED',
        message: 'Missing or invalid Authorization header.',
      });
    }

    const token = header.slice('Bearer '.length).trim();
    try {
      const payload = await this.jwtService.verifyAsync<{
        sub: string;
        email: string;
        name: string;
      }>(token);
      (request as Request & { user?: unknown }).user = {
        id: payload.sub,
        email: payload.email,
        name: payload.name,
      };
      return true;
    } catch {
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'UNAUTHORIZED',
        message: 'Missing or invalid Authorization header.',
      });
    }
  }
}
