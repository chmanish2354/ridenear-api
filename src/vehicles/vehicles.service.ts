import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type Vehicle } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type { SearchVehiclesQuery } from './dto/search-vehicles.query.js';
import { haversineDistanceKm } from './haversine.js';

export type VehicleSearchResult = Omit<Vehicle, 'anchorLat' | 'anchorLng'> & {
  distanceKm: number;
};

export type PublicVehicle = Omit<Vehicle, 'anchorLat' | 'anchorLng'> & {
  distanceKm?: number;
};

export type AvailabilityResult =
  | { available: true }
  | { available: false; conflicts: string[] };

export type RentalPrice = {
  dayCount: number;
  pricePerDay: number;
  totalPrice: number;
  securityDeposit: number;
  currency: 'INR';
};

const DAY_MS = 24 * 60 * 60 * 1000;

export class VehicleNotFoundException extends HttpException {
  constructor() {
    super(
      {
        statusCode: 404,
        code: 'VEHICLE_NOT_FOUND',
        message: 'Vehicle was not found.',
      },
      HttpStatus.NOT_FOUND,
    );
  }
}

export function rentalDayCount(start: Date, end: Date): number {
  return Math.max(1, Math.ceil((end.getTime() - start.getTime()) / DAY_MS));
}

@Injectable()
export class VehiclesService {
  constructor(private readonly prisma: PrismaService) {}

  async search(query: SearchVehiclesQuery): Promise<VehicleSearchResult[]> {
    const radiusKm = query.radiusKm ?? 10;
    const where: Prisma.VehicleWhereInput = {
      status: { not: 'maintenance' },
    };

    if (query.type !== undefined) {
      where.type = query.type;
    }
    if (query.transmission !== undefined) {
      where.transmission = query.transmission;
    }
    if (query.maxPricePerDay !== undefined) {
      where.pricePerDay = { lte: query.maxPricePerDay };
    }
    if (query.startDate !== undefined && query.endDate !== undefined) {
      where.reservations = {
        none: {
          status: 'confirmed',
          startAt: { lt: new Date(query.endDate) },
          endAt: { gt: new Date(query.startDate) },
        },
      };
    }

    const vehicles = await this.prisma.vehicle.findMany({ where });

    return vehicles
      .map((vehicle) => {
        const distanceKm = haversineDistanceKm(
          query.lat,
          query.lng,
          vehicle.currentLat,
          vehicle.currentLng,
        );
        return {
          id: vehicle.id,
          make: vehicle.make,
          model: vehicle.model,
          year: vehicle.year,
          type: vehicle.type,
          transmission: vehicle.transmission,
          fuel: vehicle.fuel,
          seats: vehicle.seats,
          pricePerDay: vehicle.pricePerDay,
          securityDeposit: vehicle.securityDeposit,
          status: vehicle.status,
          currentLat: vehicle.currentLat,
          currentLng: vehicle.currentLng,
          imageUrl: vehicle.imageUrl,
          updatedAt: vehicle.updatedAt,
          distanceKm,
        };
      })
      .filter((vehicle) => vehicle.distanceKm <= radiusKm)
      .sort((a, b) => {
        if (a.distanceKm !== b.distanceKm) {
          return a.distanceKm - b.distanceKm;
        }
        return a.id.localeCompare(b.id);
      });
  }

  async details(
    id: string,
    coordinates?: { lat: number; lng: number },
  ): Promise<PublicVehicle> {
    const vehicle = await this.requireVehicle(id);
    const pub = toPublicVehicle(vehicle);
    if (!coordinates) {
      return pub;
    }
    return {
      ...pub,
      distanceKm: haversineDistanceKm(
        coordinates.lat,
        coordinates.lng,
        vehicle.currentLat,
        vehicle.currentLng,
      ),
    };
  }

  async availability(
    id: string,
    startDate: string,
    endDate: string,
  ): Promise<AvailabilityResult> {
    const vehicle = await this.requireVehicle(id);
    const conflicts = await this.overlappingReservations(id, startDate, endDate);
    if (vehicle.status === 'maintenance' || conflicts.length > 0) {
      return { available: false, conflicts };
    }
    return { available: true };
  }

  async price(
    id: string,
    startDate: string,
    endDate: string,
  ): Promise<RentalPrice> {
    const vehicle = await this.requireVehicle(id);
    const dayCount = rentalDayCount(new Date(startDate), new Date(endDate));
    return {
      dayCount,
      pricePerDay: vehicle.pricePerDay,
      totalPrice: dayCount * vehicle.pricePerDay,
      securityDeposit: vehicle.securityDeposit,
      currency: 'INR',
    };
  }

  private async requireVehicle(id: string): Promise<Vehicle> {
    const vehicle = await this.prisma.vehicle.findUnique({ where: { id } });
    if (!vehicle) {
      throw new VehicleNotFoundException();
    }
    return vehicle;
  }

  async overlappingReservations(
    vehicleId: string,
    startDate: string,
    endDate: string,
    db: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<string[]> {
    const rows = await db.reservation.findMany({
      where: {
        vehicleId,
        status: 'confirmed',
        startAt: { lt: new Date(endDate) },
        endAt: { gt: new Date(startDate) },
      },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }
}

function toPublicVehicle(vehicle: Vehicle): Omit<PublicVehicle, 'distanceKm'> {
  return {
    id: vehicle.id,
    make: vehicle.make,
    model: vehicle.model,
    year: vehicle.year,
    type: vehicle.type,
    transmission: vehicle.transmission,
    fuel: vehicle.fuel,
    seats: vehicle.seats,
    pricePerDay: vehicle.pricePerDay,
    securityDeposit: vehicle.securityDeposit,
    status: vehicle.status,
    currentLat: vehicle.currentLat,
    currentLng: vehicle.currentLng,
    imageUrl: vehicle.imageUrl,
    updatedAt: vehicle.updatedAt,
  };
}
