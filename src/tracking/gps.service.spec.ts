import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { GpsService } from './gps.service.js';
import { RealtimeService } from './realtime.js';

const updatedAt = new Date('2026-10-01T10:00:00.000Z');

function vehicle(id: string, status: string) {
  return {
    id,
    status,
    currentLat: 12.9716,
    currentLng: 77.5946,
    anchorLat: 12.9716,
    anchorLng: 77.5946,
  };
}

describe('GpsService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('saves the new point and only then emits vehicle:location', async () => {
    const order: string[] = [];
    const update = vi.fn(async (args: { where: { id: string }; data: { currentLat: number; currentLng: number } }) => {
      order.push(`save:${args.where.id}`);
      return {
        id: args.where.id,
        currentLat: args.data.currentLat,
        currentLng: args.data.currentLng,
        updatedAt,
      };
    });
    const emitLocation = vi.fn(() => {
      order.push('emit');
    });
    const service = new GpsService(
      { vehicle: { findMany: vi.fn().mockResolvedValue([vehicle('veh-1', 'available')]), update } } as unknown as PrismaService,
      { get: () => undefined } as unknown as ConfigService,
      { emitLocation } as unknown as RealtimeService,
    );

    await service.tick();

    expect(update).toHaveBeenCalledTimes(1);
    const data = update.mock.calls[0][0].data;
    expect(data.currentLat).not.toBe(12.9716);
    expect(data).not.toHaveProperty('status');
    expect(data).not.toHaveProperty('anchorLat');
    expect(order).toEqual(['save:veh-1', 'emit']);
    expect(emitLocation).toHaveBeenCalledWith({
      vehicleId: 'veh-1',
      lat: data.currentLat,
      lng: data.currentLng,
      updatedAt: '2026-10-01T10:00:00.000Z',
    });
  });

  it('does not move or emit a maintenance vehicle', async () => {
    const update = vi.fn();
    const emitLocation = vi.fn();
    const service = new GpsService(
      {
        vehicle: {
          findMany: vi.fn().mockResolvedValue([vehicle('shop', 'maintenance')]),
          update,
        },
      } as unknown as PrismaService,
      { get: () => '2000' } as unknown as ConfigService,
      { emitLocation } as unknown as RealtimeService,
    );

    await service.tick();

    expect(update).not.toHaveBeenCalled();
    expect(emitLocation).not.toHaveBeenCalled();
  });

  it('skips a maintenance row and still saves the following available vehicle', async () => {
    const update = vi.fn(
      async (args: { where: { id: string }; data: { currentLat: number; currentLng: number } }) => ({
        id: args.where.id,
        currentLat: args.data.currentLat,
        currentLng: args.data.currentLng,
        updatedAt,
      }),
    );
    const emitLocation = vi.fn();
    const service = new GpsService(
      {
        vehicle: {
          findMany: vi.fn().mockResolvedValue([
            vehicle('shop', 'maintenance'),
            vehicle('veh-1', 'available'),
          ]),
          update,
        },
      } as unknown as PrismaService,
      { get: () => undefined } as unknown as ConfigService,
      { emitLocation } as unknown as RealtimeService,
    );

    await service.tick();

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].where).toEqual({ id: 'veh-1' });
    expect(update.mock.calls[0][0].data).not.toHaveProperty('status');
    expect(update.mock.calls[0][0].data).not.toHaveProperty('anchorLat');
    expect(emitLocation).toHaveBeenCalledTimes(1);
    expect(emitLocation.mock.calls[0][0].vehicleId).toBe('veh-1');
  });

  it('ticks once after 2000 ms when GPS_TICK_MS is missing', async () => {
    vi.useFakeTimers();
    const service = new GpsService(
      { vehicle: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn() } } as unknown as PrismaService,
      { get: () => undefined } as unknown as ConfigService,
      { emitLocation: vi.fn() } as unknown as RealtimeService,
    );
    const tick = vi.spyOn(service, 'tick').mockResolvedValue();

    service.onModuleInit();
    await vi.advanceTimersByTimeAsync(1999);
    expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
  });

  it('runs the walk on GPS_TICK_MS inside the API process', async () => {
    vi.useFakeTimers();
    const service = new GpsService(
      { vehicle: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn() } } as unknown as PrismaService,
      { get: (key: string) => (key === 'GPS_TICK_MS' ? '2000' : undefined) } as unknown as ConfigService,
      { emitLocation: vi.fn() } as unknown as RealtimeService,
    );
    const tick = vi.spyOn(service, 'tick').mockResolvedValue();

    service.onModuleInit();
    await vi.advanceTimersByTimeAsync(2000);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(tick).toHaveBeenCalledTimes(3);
    service.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(4000);
    expect(tick).toHaveBeenCalledTimes(3);
  });
});
