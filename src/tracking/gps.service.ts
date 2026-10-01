import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeService } from './realtime.js';
import { stepPosition } from './step-position.js';

@Injectable()
export class GpsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GpsService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleInit(): void {
    const ms = tickMs(this.config.get<string | number>('GPS_TICK_MS'));
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.logger.error(error);
      });
    }, ms);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const vehicles = await this.prisma.vehicle.findMany();
      for (const vehicle of vehicles) {
        try {
          const next = stepPosition(vehicle);
          if (!next) {
            continue;
          }
          const saved = await this.prisma.vehicle.update({
            where: { id: vehicle.id },
            data: { currentLat: next.lat, currentLng: next.lng },
          });
          this.realtime.emitLocation({
            vehicleId: saved.id,
            lat: saved.currentLat,
            lng: saved.currentLng,
            updatedAt: saved.updatedAt.toISOString(),
          });
        } catch (error: unknown) {
          this.logger.error(error);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

function tickMs(raw: string | number | undefined): number {
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 2000;
  }
  return parsed;
}
