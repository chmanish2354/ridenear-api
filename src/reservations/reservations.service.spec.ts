import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { VehicleNotFoundException, VehiclesService } from '../vehicles/vehicles.service.js';
import { CreateReservationDto } from './dto/create-reservation.dto.js';
import { ReservationValidationErrorFilter } from './reservation-validation-error.filter.js';
import { ReservationsController } from './reservations.controller.js';
import {
  ReservationNotFoundException,
  ReservationOverlapException,
  ReservationsService,
  VehicleUnavailableException,
} from './reservations.service.js';

const START = new Date('2026-10-02T04:30:00.000Z');
const END = new Date('2026-10-03T04:30:00.000Z');

function vehicle(status = 'available') {
  return {
    id: 'near-seltos',
    make: 'Kia',
    model: 'Seltos',
    year: 2023,
    pricePerDay: 2600,
    securityDeposit: 5000,
    status,
    type: 'suv',
    transmission: 'automatic',
    fuel: 'petrol',
    seats: 5,
    currentLat: 12.97,
    currentLng: 77.64,
    anchorLat: 12.97,
    anchorLng: 77.64,
    imageUrl: '',
    updatedAt: new Date('2026-09-30T00:00:00.000Z'),
  };
}

function bookingService(status = 'available', seeded: Record<string, unknown>[] = []) {
  const rows = seeded.map((row) => ({ ...row }));
  const vehicleUpdate = vi.fn();
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    const row = {
      id: `res-${rows.length + 1}`,
      createdAt: new Date('2026-10-01T12:00:00.000Z'),
      ...data,
      vehicle: vehicle(status),
    };
    rows.push(row);
    return row;
  });
  const db = {
    vehicle: {
      findUnique: vi.fn(async () => vehicle(status)),
      update: vehicleUpdate,
    },
    reservation: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return (
          rows.find(
            (row) =>
              row.userId === where.userId &&
              row.vehicleId === where.vehicleId &&
              row.status === where.status &&
              row.startAt instanceof Date &&
              where.startAt instanceof Date &&
              (row.startAt as Date).getTime() === where.startAt.getTime() &&
              (row.endAt as Date).getTime() === (where.endAt as Date).getTime(),
          ) ?? null
        );
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const startAt = where.startAt as { lt?: Date } | undefined;
        const endAt = where.endAt as { gt?: Date } | undefined;
        return rows
          .filter((row) => {
            if (where.status && row.status !== where.status) {
              return false;
            }
            if (where.vehicleId && row.vehicleId !== where.vehicleId) {
              return false;
            }
            if (where.userId && row.userId !== where.userId) {
              return false;
            }
            if (startAt?.lt && !((row.startAt as Date).getTime() < startAt.lt.getTime())) {
              return false;
            }
            if (endAt?.gt && !((row.endAt as Date).getTime() > endAt.gt.getTime())) {
              return false;
            }
            return true;
          })
          .map((row) => ({ id: row.id as string }));
      }),
      create,
      update: vi.fn(),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  const vehicles = new VehiclesService(db as unknown as PrismaService);
  return {
    rows,
    create,
    vehicleUpdate,
    db,
    service: new ReservationsService(db as unknown as PrismaService, vehicles),
  };
}

describe('ReservationsService', () => {
  it('returns HTTP 409 RESERVATION_OVERLAP and does not insert a second row', async () => {
    const { service, create, rows } = bookingService('available', [
      {
        id: 'res-other',
        userId: 'other-user',
        vehicleId: 'near-seltos',
        status: 'confirmed',
        startAt: new Date('2026-10-02T00:00:00.000Z'),
        endAt: new Date('2026-10-02T12:00:00.000Z'),
        vehicle: vehicle(),
      },
    ]);

    await expect(
      service.create('priya-user', {
        vehicleId: 'near-seltos',
        startDate: '2026-10-02T04:30:00.000Z',
        endDate: '2026-10-03T04:30:00.000Z',
      }),
    ).rejects.toBeInstanceOf(ReservationOverlapException);

    await expect(
      service.create('priya-user', {
        vehicleId: 'near-seltos',
        startDate: '2026-10-02T04:30:00.000Z',
        endDate: '2026-10-03T04:30:00.000Z',
      }),
    ).rejects.toMatchObject({
      response: {
        statusCode: 409,
        code: 'RESERVATION_OVERLAP',
        message: 'Vehicle is already reserved for the selected dates.',
      },
    });
    expect(create).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
  });

  it('rejects maintenance with VEHICLE_UNAVAILABLE and leaves an unknown id as not found', async () => {
    const maintenance = bookingService('maintenance');
    await expect(
      maintenance.service.create('priya-user', {
        vehicleId: 'near-seltos',
        startDate: START.toISOString(),
        endDate: END.toISOString(),
      }),
    ).rejects.toBeInstanceOf(VehicleUnavailableException);
    await expect(
      maintenance.service.create('priya-user', {
        vehicleId: 'near-seltos',
        startDate: START.toISOString(),
        endDate: END.toISOString(),
      }),
    ).rejects.toMatchObject({
      response: {
        statusCode: 409,
        code: 'VEHICLE_UNAVAILABLE',
        message: 'This vehicle cannot be reserved.',
      },
    });
    expect(maintenance.create).not.toHaveBeenCalled();
    expect(maintenance.vehicleUpdate).not.toHaveBeenCalled();

    const missing = bookingService();
    missing.db.vehicle.findUnique.mockResolvedValue(null);
    await expect(
      missing.service.create('priya-user', {
        vehicleId: 'missing',
        startDate: START.toISOString(),
        endDate: END.toISOString(),
      }),
    ).rejects.toBeInstanceOf(VehicleNotFoundException);
  });

  it('lists only the caller, newest first, and cancels only the owner', async () => {
    const older = {
      id: 'res-old',
      userId: 'priya-user',
      vehicleId: 'near-seltos',
      status: 'confirmed',
      startAt: START,
      endAt: END,
      dayCount: 1,
      pricePerDay: 2600,
      totalPrice: 2600,
      currency: 'INR',
      createdAt: new Date('2026-10-01T08:00:00.000Z'),
      vehicle: vehicle(),
    };
    const newer = {
      ...older,
      id: 'res-new',
      createdAt: new Date('2026-10-01T09:00:00.000Z'),
    };
    const findMany = vi.fn().mockResolvedValue([newer, older]);
    const findFirst = vi.fn();
    const update = vi.fn().mockResolvedValue({ ...newer, status: 'cancelled' });
    const prisma = {
      reservation: { findMany, findFirst, update },
    };
    const service = new ReservationsService(
      prisma as unknown as PrismaService,
      {} as VehiclesService,
    );

    const listed = await service.listMine('priya-user');
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'priya-user' },
      orderBy: { createdAt: 'desc' },
      include: { vehicle: true },
    });
    expect(listed.map((row) => row.id)).toEqual(['res-new', 'res-old']);

    findFirst.mockResolvedValueOnce(null);
    await expect(service.cancel('priya-user', 'someone-elses')).rejects.toBeInstanceOf(
      ReservationNotFoundException,
    );
    await expect(service.cancel('priya-user', 'someone-elses')).rejects.toMatchObject({
      response: {
        statusCode: 404,
        code: 'RESERVATION_NOT_FOUND',
        message: 'Reservation was not found.',
      },
    });
    expect(update).not.toHaveBeenCalled();

    findFirst.mockResolvedValueOnce(newer);
    const cancelled = await service.cancel('priya-user', 'res-new');
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'res-new', userId: 'priya-user' },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'res-new' },
      data: { status: 'cancelled' },
      include: { vehicle: true },
    });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.id).toBe('res-new');
  });
});

describe('ReservationsController', () => {
  it('creates with HTTP 201 for the JWT user and does not take a user id from the body', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'res-1' });
    const listMine = vi.fn().mockResolvedValue([]);
    const cancel = vi.fn();
    const controller = new ReservationsController({
      create,
      listMine,
      cancel,
    } as unknown as ReservationsService);

    await controller.create({ user: { id: 'priya-user' } } as never, {
      vehicleId: 'near-seltos',
      startDate: START.toISOString(),
      endDate: END.toISOString(),
    });
    expect(create).toHaveBeenCalledWith('priya-user', {
      vehicleId: 'near-seltos',
      startDate: START.toISOString(),
      endDate: END.toISOString(),
    });
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, ReservationsController.prototype.create)).toBe(
      201,
    );

    await controller.listMine({ user: { id: 'priya-user' } } as never);
    expect(listMine).toHaveBeenCalledWith('priya-user');

    await controller.cancel({ user: { id: 'priya-user' } } as never, 'res-1');
    expect(cancel).toHaveBeenCalledWith('priya-user', 'res-1');
  });
});

describe('reservation validation', () => {
  it('returns VALIDATION_ERROR for an invalid reservation body', async () => {
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    new ReservationValidationErrorFilter().catch(new BadRequestException('ignored'), {
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    } as never);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Reservation is not valid.',
    });

    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    const validDates = {
      startDate: START.toISOString(),
      endDate: END.toISOString(),
    };
    await expect(
      pipe.transform(
        { vehicleId: '', ...validDates },
        { type: 'body', metatype: CreateReservationDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      pipe.transform(
        {
          vehicleId: 'near-seltos',
          startDate: END.toISOString(),
          endDate: START.toISOString(),
        },
        { type: 'body', metatype: CreateReservationDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
