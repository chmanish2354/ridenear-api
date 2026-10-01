import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { describe, expect, it, vi } from 'vitest';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';

function httpContext(authorization?: string): ExecutionContext {
  const request = { headers: { authorization } };
  return {
    getHandler: () => function login() {},
    getClass: () => class AuthController {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  const getAllAndOverride = vi.fn();
  const verifyAsync = vi.fn();
  const guard = new JwtAuthGuard(
    { verifyAsync } as unknown as JwtService,
    { getAllAndOverride } as unknown as Reflector,
  );

  it('allows a public login route without a token', async () => {
    getAllAndOverride.mockReturnValue(true);

    await expect(guard.canActivate(httpContext())).resolves.toBe(true);
    expect(getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, [
      expect.any(Function),
      expect.any(Function),
    ]);
    expect(verifyAsync).not.toHaveBeenCalled();
  });

  it('rejects health without a Bearer token', async () => {
    getAllAndOverride.mockReturnValue(false);

    await expect(guard.canActivate(httpContext())).rejects.toMatchObject({
      response: {
        statusCode: 401,
        code: 'UNAUTHORIZED',
        message: 'Missing or invalid Authorization header.',
      },
    });
  });

  it('rejects an invalid Bearer token', async () => {
    getAllAndOverride.mockReturnValue(false);
    verifyAsync.mockRejectedValue(new Error('jwt expired'));

    await expect(
      guard.canActivate(httpContext('Bearer not-a-jwt')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
