import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { HealthService } from './health.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConfigService } from '@nestjs/config';

describe('HealthService', () => {
  const queryRaw = vi.fn();

  beforeEach(() => {
    queryRaw.mockReset();
    queryRaw.mockResolvedValue([{ '?column?': 1 }]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports aiService down when Python is unreachable and leaves the API up', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')),
    );
    const service = new HealthService(
      { $queryRaw: queryRaw } as unknown as PrismaService,
      {
        get: (key: string) =>
          key === 'AI_SERVICE_URL' ? 'http://127.0.0.1:9' : undefined,
      } as unknown as ConfigService,
    );

    await expect(service.check()).resolves.toEqual({
      api: 'up',
      database: 'up',
      aiService: 'down',
    });
    expect(queryRaw).toHaveBeenCalled();
  });

  it('reports aiService up only when Python returns status ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'ok', vectorCount: 0 }),
      }),
    );
    const service = serviceWithAi(queryRaw, 'http://ai:8000');

    await expect(service.check()).resolves.toMatchObject({ aiService: 'up' });
  });

  it('reports aiService down when Python is up but status is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'healthy', vectorCount: 0 }),
      }),
    );
    const service = serviceWithAi(queryRaw, 'http://ai:8000');

    await expect(service.check()).resolves.toMatchObject({ aiService: 'down' });
  });

  it('reports database down when the probe fails', async () => {
    queryRaw.mockRejectedValue(new Error('connection refused'));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('ai down')),
    );
    const service = serviceWithAi(queryRaw, 'http://ai:8000');

    await expect(service.check()).resolves.toMatchObject({
      api: 'up',
      database: 'down',
    });
  });
});

function serviceWithAi(
  queryRaw: ReturnType<typeof vi.fn>,
  url: string,
) {
  return new HealthService(
    { $queryRaw: queryRaw } as unknown as PrismaService,
    {
      get: (key: string) => (key === 'AI_SERVICE_URL' ? url : undefined),
    } as unknown as ConfigService,
  );
}
