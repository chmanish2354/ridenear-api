import {
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service.js';
import { LoginDto } from './dto/login.dto.js';

export type AuthUser = {
  id: string;
  name: string;
  email: string;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async login(dto: LoginDto): Promise<{ token: string; user: AuthUser }> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    if (!user) {
      throw this.invalidCredentials();
    }

    const matches = await bcrypt.compare(dto.password, user.passwordHash);
    if (!matches) {
      throw this.invalidCredentials();
    }

    const token = await this.jwtService.signAsync({
      sub: user.id,
      email: user.email,
      name: user.name,
    });

    return {
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
    };
  }

  private invalidCredentials(): HttpException {
    return new HttpException(
      {
        statusCode: 401,
        code: 'INVALID_CREDENTIALS',
        message: 'Email or password is not valid.',
      },
      HttpStatus.UNAUTHORIZED,
    );
  }
}
