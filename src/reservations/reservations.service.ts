import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  rentalDayCount,
  VehicleNotFoundException,
  VehiclesService,
} from '../vehicles/vehicles.service.js';

export type ReservationView = {
  id: string;
  vehicleId: string;
  year: number;
  make: string;
  model: string;
  startAt: string;
  endAt: string;
  dayCount: number;
  pricePerDay: number;
  totalPrice: number;
  securityDeposit: number;
  currency: 'INR';
  status: string;
  createdAt: string;
};

export type CreateReservationInput = {
  vehicleId: string;
  startDate: string;
  endDate: string;
};

type ReservationRow = {
  id: string;
  vehicleId: string;
  startAt: Date;
  endAt: Date;
  dayCount: number;
  pricePerDay: number;
  totalPrice: number;
  currency: string;
  status: string;
  createdAt: Date;
  vehicle: {
    year: number;
    make: string;
    model: string;
    securityDeposit: number;
  };
};

export class ReservationOverlapException extends HttpException {
  constructor() {
    super(
      {
        statusCode: 409,
        code: 'RESERVATION_OVERLAP',
        message: 'Vehicle is already reserved for the selected dates.',
      },
      HttpStatus.CONFLICT,
    );
  }
}

export class VehicleUnavailableException extends HttpException {
  constructor() {
    super(
      {
        statusCode: 409,
        code: 'VEHICLE_UNAVAILABLE',
        message: 'This vehicle cannot be reserved.',
      },
      HttpStatus.CONFLICT,
    );
  }
}

export class ReservationNotFoundException extends HttpException {
  constructor() {
    super(
      {
        statusCode: 404,
        code: 'RESERVATION_NOT_FOUND',
        message: 'Reservation was not found.',
      },
      HttpStatus.NOT_FOUND,
    );
  }
}

export function normalizeInstant(value: string): Date {
  return new Date(new Date(value).toISOString());
}

@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vehicles: VehiclesService,
  ) {}

  async create(
    userId: string,
    input: CreateReservationInput,
  ): Promise<ReservationView> {
    const startAt = normalizeInstant(input.startDate);
    const endAt = normalizeInstant(input.endDate);

    const saved = await this.prisma.$transaction(async (tx) => {
      const vehicle = await tx.vehicle.findUnique({
        where: { id: input.vehicleId },
      });
      if (!vehicle) {
        throw new VehicleNotFoundException();
      }

      const existing = await tx.reservation.findFirst({
        where: {
          userId,
          vehicleId: input.vehicleId,
          status: 'confirmed',
          startAt,
          endAt,
        },
        include: { vehicle: true },
      });
      if (existing) {
        return existing;
      }

      if (vehicle.status === 'maintenance') {
        throw new VehicleUnavailableException();
      }

      const conflicts = await this.vehicles.overlappingReservations(
        input.vehicleId,
        startAt.toISOString(),
        endAt.toISOString(),
        tx,
      );
      if (conflicts.length > 0) {
        throw new ReservationOverlapException();
      }

      const dayCount = rentalDayCount(startAt, endAt);
      return tx.reservation.create({
        data: {
          userId,
          vehicleId: input.vehicleId,
          startAt,
          endAt,
          dayCount,
          pricePerDay: vehicle.pricePerDay,
          totalPrice: dayCount * vehicle.pricePerDay,
          currency: 'INR',
          status: 'confirmed',
        },
        include: { vehicle: true },
      });
    });

    return toView(saved);
  }

  async listMine(userId: string): Promise<ReservationView[]> {
    const rows = await this.prisma.reservation.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { vehicle: true },
    });
    return rows.map((row) => toView(row));
  }

  async cancel(userId: string, id: string): Promise<ReservationView> {
    const existing = await this.prisma.reservation.findFirst({
      where: { id, userId },
    });
    if (!existing) {
      throw new ReservationNotFoundException();
    }
    const updated = await this.prisma.reservation.update({
      where: { id },
      data: { status: 'cancelled' },
      include: { vehicle: true },
    });
    return toView(updated);
  }
}

function toView(row: ReservationRow): ReservationView {
  return {
    id: row.id,
    vehicleId: row.vehicleId,
    year: row.vehicle.year,
    make: row.vehicle.make,
    model: row.vehicle.model,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
    dayCount: row.dayCount,
    pricePerDay: row.pricePerDay,
    totalPrice: row.totalPrice,
    securityDeposit: row.vehicle.securityDeposit,
    currency: 'INR',
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}
