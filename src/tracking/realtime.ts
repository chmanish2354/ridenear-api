import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service.js';

export type SnapshotPoint = {
  vehicleId: string;
  lat: number;
  lng: number;
};

export type LocationUpdate = SnapshotPoint & {
  updatedAt: string;
};

@Injectable()
export class RealtimeService implements OnModuleDestroy {
  private readonly logger = new Logger(RealtimeService.name);
  private io: Server | null = null;

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  attach(httpServer: HttpServer): void {
    if (this.io) {
      return;
    }

    const origin = this.config.getOrThrow<string>('CORS_ORIGIN');
    const io = new Server(httpServer, {
      path: '/realtime',
      cors: { origin, credentials: true },
    });
    this.io = io;

    io.use((socket, next) => {
      void this.authorize(socket)
        .then(() => next())
        .catch(() => next(new Error('unauthorized')));
    });

    io.on('connection', (socket) => {
      socket.on('tracking:subscribe', (payload: unknown) => {
        void this.subscribe(socket, payload).catch((error: unknown) => {
          this.logger.error(error);
        });
      });
    });
  }

  emitLocation(update: LocationUpdate): void {
    if (!this.io) {
      return;
    }
    this.io
      .to('tracking')
      .to(`vehicle:${update.vehicleId}`)
      .emit('vehicle:location', {
        vehicleId: update.vehicleId,
        lat: update.lat,
        lng: update.lng,
        updatedAt: update.updatedAt,
      });
  }

  async close(): Promise<void> {
    if (!this.io) {
      return;
    }
    await this.io.close();
    this.io = null;
  }

  onModuleDestroy(): void {
    void this.close();
  }

  private async authorize(socket: Socket): Promise<void> {
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string' || token.trim() === '') {
      throw new Error('unauthorized');
    }
    await this.jwt.verifyAsync(token);
  }

  private async subscribe(socket: Socket, payload: unknown): Promise<void> {
    if (!socket.connected) {
      return;
    }
    await socket.join('tracking');
    const vehicleId = readVehicleId(payload);
    if (vehicleId) {
      await socket.join(`vehicle:${vehicleId}`);
    }
    const vehicles = await this.prisma.vehicle.findMany({
      where: { status: { not: 'maintenance' } },
      select: { id: true, currentLat: true, currentLng: true },
    });
    if (!socket.connected) {
      return;
    }
    const snapshot: SnapshotPoint[] = vehicles.map((vehicle) => ({
      vehicleId: vehicle.id,
      lat: vehicle.currentLat,
      lng: vehicle.currentLng,
    }));
    socket.emit('vehicle:snapshot', snapshot);
  }
}

function readVehicleId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const vehicleId = (payload as { vehicleId?: unknown }).vehicleId;
  if (typeof vehicleId !== 'string' || vehicleId.trim() === '') {
    return null;
  }
  return vehicleId;
}
