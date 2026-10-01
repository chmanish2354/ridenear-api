import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';

export type HealthStatus = 'up' | 'down';

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async check(): Promise<{
    api: HealthStatus;
    database: HealthStatus;
    aiService: HealthStatus;
  }> {
    const database = await this.checkDatabase();
    const aiService = await this.checkAiService();
    return {
      api: 'up',
      database,
      aiService,
    };
  }

  private async checkDatabase(): Promise<HealthStatus> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async checkAiService(): Promise<HealthStatus> {
    const baseUrl = this.config.get<string>('AI_SERVICE_URL');
    if (!baseUrl) {
      return 'down';
    }
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) {
        return 'down';
      }
      const body = (await response.json()) as { status?: string };
      return body.status === 'ok' ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }
}
