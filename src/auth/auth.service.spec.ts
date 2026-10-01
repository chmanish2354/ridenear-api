import { describe, expect, it, vi, beforeEach } from 'vitest';
import { HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service.js';
import { jwtModuleOptions } from './auth.module.js';
import { PrismaService } from '../prisma/prisma.service.js';

vi.mock('bcrypt', () => ({
  compare: vi.fn(),
}));

describe('AuthService', () => {
  const findUnique = vi.fn();
  const signAsync = vi.fn();
  let service: AuthService;

  beforeEach(() => {
    findUnique.mockReset();
    signAsync.mockReset();
    vi.mocked(bcrypt.compare).mockReset();
    service = new AuthService(
      { user: { findUnique } } as unknown as PrismaService,
      { signAsync } as unknown as JwtService,
    );
  });

  it('issues a 12-hour JWT payload path for a valid password', async () => {
    findUnique.mockResolvedValue({
      id: 'user-1',
      name: 'Priya Sharma',
      email: 'priya@ridenear.demo',
      passwordHash: 'hashed',
    });
    vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
    signAsync.mockResolvedValue('signed-jwt');

    const result = await service.login({
      email: 'priya@ridenear.demo',
      password: 'DRN(DiscoverRideNear)#2026',
    });

    expect(result).toEqual({
      token: 'signed-jwt',
      user: {
        id: 'user-1',
        name: 'Priya Sharma',
        email: 'priya@ridenear.demo',
      },
    });
    expect(signAsync).toHaveBeenCalledWith({
      sub: 'user-1',
      email: 'priya@ridenear.demo',
      name: 'Priya Sharma',
    });
  });

  it('signs a token that expires 12 hours after issue', async () => {
    const options = jwtModuleOptions({
      getOrThrow: () => 'test-secret',
    } as unknown as import('@nestjs/config').ConfigService);
    expect(options.signOptions.expiresIn).toBe('12h');

    const jwt = new JwtService({
      secret: options.secret,
      signOptions: options.signOptions,
    });
    const realService = new AuthService(
      { user: { findUnique } } as unknown as PrismaService,
      jwt,
    );
    findUnique.mockResolvedValue({
      id: 'user-1',
      name: 'Priya Sharma',
      email: 'priya@ridenear.demo',
      passwordHash: 'hashed',
    });
    vi.mocked(bcrypt.compare).mockResolvedValue(true as never);

    const result = await realService.login({
      email: 'priya@ridenear.demo',
      password: 'DRN(DiscoverRideNear)#2026',
    });
    const payload = jwt.decode(result.token) as { exp: number; iat: number };
    expect(payload.exp - payload.iat).toBe(12 * 60 * 60);
    expect(result.user.name).toBe('Priya Sharma');
  });

  it('rejects a wrong password with INVALID_CREDENTIALS', async () => {
    findUnique.mockResolvedValue({
      id: 'user-1',
      name: 'Priya Sharma',
      email: 'priya@ridenear.demo',
      passwordHash: 'hashed',
    });
    vi.mocked(bcrypt.compare).mockResolvedValue(false as never);

    await expect(
      service.login({
        email: 'priya@ridenear.demo',
        password: 'wrong',
      }),
    ).rejects.toBeInstanceOf(HttpException);

    try {
      await service.login({
        email: 'priya@ridenear.demo',
        password: 'wrong',
      });
    } catch (error) {
      const exception = error as HttpException;
      expect(exception.getStatus()).toBe(401);
      expect(exception.getResponse()).toEqual({
        statusCode: 401,
        code: 'INVALID_CREDENTIALS',
        message: 'Email or password is not valid.',
      });
    }
  });

  it('looks up a mixed-case email in lowercase', async () => {
    findUnique.mockResolvedValue(null);

    await expect(
      service.login({
        email: 'Priya@ridenear.demo',
        password: 'anything',
      }),
    ).rejects.toBeInstanceOf(HttpException);

    expect(findUnique).toHaveBeenCalledWith({
      where: { email: 'priya@ridenear.demo' },
    });
  });

  it('rejects an unknown email with INVALID_CREDENTIALS', async () => {
    findUnique.mockResolvedValue(null);

    try {
      await service.login({
        email: 'nobody@ridenear.demo',
        password: 'anything',
      });
      expect.fail('expected rejection');
    } catch (error) {
      const exception = error as HttpException;
      expect(exception.getStatus()).toBe(401);
      expect(exception.getResponse()).toEqual({
        statusCode: 401,
        code: 'INVALID_CREDENTIALS',
        message: 'Email or password is not valid.',
      });
    }
  });
});
