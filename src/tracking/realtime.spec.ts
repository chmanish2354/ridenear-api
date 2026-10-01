import type { AddressInfo } from 'node:net';
import { createServer, type Server as HttpServer } from 'node:http';
import { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import type { Server } from 'socket.io';
import { io, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeService, type SnapshotPoint } from './realtime.js';

const secret = 'tracking-test-secret';

function config(): ConfigService {
  return {
    getOrThrow: (key: string) => {
      if (key === 'CORS_ORIGIN') {
        return 'http://localhost:5173';
      }
      throw new Error(`missing ${key}`);
    },
  } as unknown as ConfigService;
}

async function listen(server: HttpServer): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return (server.address() as AddressInfo).port;
}

function connect(port: number, token?: string): Socket {
  return io(`http://127.0.0.1:${port}`, {
    path: '/realtime',
    auth: token === undefined ? {} : { token },
    reconnection: false,
    timeout: 2000,
  });
}

describe('RealtimeService', () => {
  const clients: Socket[] = [];
  let http: HttpServer | null = null;
  let service: RealtimeService | null = null;

  afterEach(async () => {
    for (const client of clients) {
      client.close();
    }
    clients.length = 0;
    await service?.close();
    service = null;
    if (http) {
      const closing = http;
      http = null;
      await new Promise<void>((resolve) => closing.close(() => resolve()));
    }
  });

  it('refuses a missing or bad token and accepts the same 12-hour JWT as REST', async () => {
    const jwt = new JwtService({
      secret,
      signOptions: { expiresIn: '12h' },
    });
    http = createServer();
    service = new RealtimeService(
      jwt,
      { vehicle: { findMany: vi.fn().mockResolvedValue([]) } } as unknown as PrismaService,
      config(),
    );
    service.attach(http);
    const port = await listen(http);

    const missing = connect(port);
    clients.push(missing);
    await expect(waitForError(missing)).resolves.toBeTruthy();

    const wrong = connect(port, 'not-a-jwt');
    clients.push(wrong);
    await expect(waitForError(wrong)).resolves.toBeTruthy();

    const expired = await jwt.signAsync(
      { sub: 'user-1', email: 'priya@ridenear.demo', name: 'Priya' },
      { expiresIn: '-10s' },
    );
    const stale = connect(port, expired);
    clients.push(stale);
    await expect(waitForError(stale)).resolves.toBeTruthy();

    const token = await jwt.signAsync({
      sub: 'user-1',
      email: 'priya@ridenear.demo',
      name: 'Priya',
    });
    const decoded = jwt.decode(token) as { exp: number; iat: number };
    expect(decoded.exp - decoded.iat).toBe(12 * 60 * 60);
    const ok = connect(port, token);
    clients.push(ok);
    await waitForConnect(ok);
  });

  it('joins tracking and vehicle rooms and sends one snapshot without maintenance or anchors', async () => {
    const jwt = new JwtService({
      secret,
      signOptions: { expiresIn: '12h' },
    });
    const findMany = vi.fn().mockResolvedValue([
      { id: 'veh-1', currentLat: 12.97, currentLng: 77.59 },
      { id: 'veh-2', currentLat: 12.98, currentLng: 77.6 },
    ]);
    http = createServer();
    service = new RealtimeService(jwt, { vehicle: { findMany } } as unknown as PrismaService, config());
    service.attach(http);
    const port = await listen(http);
    const token = await jwt.signAsync({
      sub: 'user-1',
      email: 'priya@ridenear.demo',
      name: 'Priya',
    });
    const client = connect(port, token);
    clients.push(client);
    await waitForConnect(client);

    const snapshotPromise = once<SnapshotPoint[]>(client, 'vehicle:snapshot');
    client.emit('tracking:subscribe', { vehicleId: 'veh-1' });
    const snapshot = await snapshotPromise;

    expect(snapshot).toEqual([
      { vehicleId: 'veh-1', lat: 12.97, lng: 77.59 },
      { vehicleId: 'veh-2', lat: 12.98, lng: 77.6 },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('anchor');
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { status: { not: 'maintenance' } },
      select: { id: true, currentLat: true, currentLng: true },
    });

    const sockets = await serverOf(service).fetchSockets();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].rooms.has('tracking')).toBe(true);
    expect(sockets[0].rooms.has('vehicle:veh-1')).toBe(true);

    const second = once<SnapshotPoint[]>(client, 'vehicle:snapshot');
    client.emit('tracking:subscribe', {});
    await second;
    const after = await serverOf(service).fetchSockets();
    expect(after[0].rooms.has('tracking')).toBe(true);
    expect(after[0].rooms.has('vehicle:veh-1')).toBe(true);

    const location = once(client, 'vehicle:location');
    service.emitLocation({
      vehicleId: 'veh-1',
      lat: 12.971,
      lng: 77.595,
      updatedAt: '2026-10-01T10:00:00.000Z',
    });
    await expect(location).resolves.toEqual({
      vehicleId: 'veh-1',
      lat: 12.971,
      lng: 77.595,
      updatedAt: '2026-10-01T10:00:00.000Z',
    });
    expect(findMany).toHaveBeenCalledTimes(2);

    const watcher = connect(port, token);
    clients.push(watcher);
    await waitForConnect(watcher);
    const watcherSnapshot = once<SnapshotPoint[]>(watcher, 'vehicle:snapshot');
    watcher.emit('tracking:subscribe', {});
    await watcherSnapshot;
    const watcherRooms = (await serverOf(service).fetchSockets()).find(
      (socket) => socket.id === watcher.id,
    );
    expect(watcherRooms?.rooms.has('tracking')).toBe(true);
    expect(watcherRooms?.rooms.has('vehicle:veh-2')).toBe(false);

    const other = once(watcher, 'vehicle:location');
    service.emitLocation({
      vehicleId: 'veh-2',
      lat: 12.982,
      lng: 77.601,
      updatedAt: '2026-10-01T10:00:02.000Z',
    });
    await expect(other).resolves.toEqual({
      vehicleId: 'veh-2',
      lat: 12.982,
      lng: 77.601,
      updatedAt: '2026-10-01T10:00:02.000Z',
    });
  });
});

function serverOf(service: RealtimeService): Server {
  return (service as unknown as { io: Server }).io;
}

function waitForConnect(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timed out')), 3000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForError(socket: Socket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('error timed out')), 3000);
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      resolve(error);
    });
    socket.once('connect', () => {
      clearTimeout(timer);
      reject(new Error('connection was accepted'));
    });
  });
}

function once<T>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), 3000);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}
