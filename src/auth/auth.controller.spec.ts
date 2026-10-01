import { HttpException, HttpStatus } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';

describe('AuthController', () => {
  const login = vi.fn();
  let controller: AuthController;

  beforeEach(() => {
    login.mockReset();
    controller = new AuthController({ login } as unknown as AuthService);
  });

  it('returns a JWT and user for a valid login', async () => {
    login.mockResolvedValue({
      token: 'jwt-token',
      user: {
        id: 'user-1',
        name: 'Priya Sharma',
        email: 'priya@ridenear.demo',
      },
    });

    const result = await controller.login({
      email: 'priya@ridenear.demo',
      password: 'DRN(DiscoverRideNear)#2026',
    });

    expect(result.token).toBe('jwt-token');
    expect(result.user).toEqual({
      id: 'user-1',
      name: 'Priya Sharma',
      email: 'priya@ridenear.demo',
    });
    expect(login).toHaveBeenCalledWith({
      email: 'priya@ridenear.demo',
      password: 'DRN(DiscoverRideNear)#2026',
    });
  });

  it('returns INVALID_CREDENTIALS for a wrong password', async () => {
    login.mockRejectedValue(
      new HttpException(
        {
          statusCode: 401,
          code: 'INVALID_CREDENTIALS',
          message: 'Email or password is not valid.',
        },
        HttpStatus.UNAUTHORIZED,
      ),
    );

    await expect(
      controller.login({
        email: 'priya@ridenear.demo',
        password: 'wrong-password',
      }),
    ).rejects.toMatchObject({
      status: 401,
      response: {
        statusCode: 401,
        code: 'INVALID_CREDENTIALS',
        message: 'Email or password is not valid.',
      },
    });
  });

  it('returns INVALID_CREDENTIALS for an unknown email', async () => {
    login.mockRejectedValue(
      new HttpException(
        {
          statusCode: 401,
          code: 'INVALID_CREDENTIALS',
          message: 'Email or password is not valid.',
        },
        HttpStatus.UNAUTHORIZED,
      ),
    );

    await expect(
      controller.login({
        email: 'unknown@ridenear.demo',
        password: 'DRN(DiscoverRideNear)#2026',
      }),
    ).rejects.toMatchObject({
      status: 401,
      response: {
        statusCode: 401,
        code: 'INVALID_CREDENTIALS',
        message: 'Email or password is not valid.',
      },
    });
  });
});
