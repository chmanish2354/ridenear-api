import {
  BadRequestException,
  ExecutionContext,
  ValidationPipe,
} from '@nestjs/common';
import { EXCEPTION_FILTERS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SearchVehiclesQuery } from './dto/search-vehicles.query.js';
import { roundDistanceKm } from './haversine.js';
import { ValidationErrorFilter } from './validation-error.filter.js';
import { VehicleDateRangeDto } from './dto/vehicle-date-range.js';
import { VehicleDetailsQuery } from './dto/vehicle-details.query.js';
import { VehiclesController } from './vehicles.controller.js';
import { VehicleNotFoundException, VehiclesService } from './vehicles.service.js';

const updatedAt = new Date('2026-09-30T00:00:00.000Z');

function latOffsetKm(km: number): number {
  return (km / 6371) * (180 / Math.PI);
}

function vehicleRow(
  partial: Partial<{
    id: string;
    make: string;
    model: string;
    year: number;
    type: string;
    transmission: string;
    fuel: string;
    seats: number;
    pricePerDay: number;
    securityDeposit: number;
    status: string;
    currentLat: number;
    currentLng: number;
    anchorLat: number;
    anchorLng: number;
    imageUrl: string;
  }>,
) {
  const lat = partial.currentLat ?? 12.97;
  const lng = partial.currentLng ?? 77.64;
  return {
    id: partial.id ?? 'id',
    make: partial.make ?? 'Make',
    model: partial.model ?? 'Model',
    year: partial.year ?? 2022,
    type: partial.type ?? 'suv',
    transmission: partial.transmission ?? 'automatic',
    fuel: partial.fuel ?? 'petrol',
    seats: partial.seats ?? 5,
    pricePerDay: partial.pricePerDay ?? 2000,
    securityDeposit: partial.securityDeposit ?? 4000,
    status: partial.status ?? 'available',
    currentLat: lat,
    currentLng: lng,
    anchorLat: partial.anchorLat ?? lat,
    anchorLng: partial.anchorLng ?? lng,
    imageUrl: partial.imageUrl ?? '',
    updatedAt,
  };
}

/** Seed-shaped rows for the MG Road pin demo (V1–V10). */
const seedVehicles = [
  vehicleRow({
    id: 'V1',
    make: 'Hyundai',
    model: 'Creta',
    type: 'suv',
    transmission: 'automatic',
    pricePerDay: 2800,
    currentLat: 12.9719,
    currentLng: 77.6412,
  }),
  vehicleRow({
    id: 'V2',
    make: 'Kia',
    model: 'Seltos',
    type: 'suv',
    transmission: 'automatic',
    pricePerDay: 2600,
    currentLat: 12.9352,
    currentLng: 77.6245,
  }),
  vehicleRow({
    id: 'V3',
    make: 'Toyota',
    model: 'Innova Crysta',
    type: 'muv',
    transmission: 'manual',
    pricePerDay: 3200,
    currentLat: 12.9833,
    currentLng: 77.594,
  }),
  vehicleRow({
    id: 'V4',
    make: 'Maruti',
    model: 'Brezza',
    type: 'suv',
    transmission: 'manual',
    pricePerDay: 1800,
    currentLat: 12.9591,
    currentLng: 77.6466,
  }),
  vehicleRow({
    id: 'V5',
    make: 'Honda',
    model: 'City',
    type: 'sedan',
    transmission: 'automatic',
    pricePerDay: 2200,
    currentLat: 12.9784,
    currentLng: 77.6408,
  }),
  vehicleRow({
    id: 'V6',
    make: 'Tata',
    model: 'Nexon',
    type: 'suv',
    transmission: 'automatic',
    pricePerDay: 2400,
    currentLat: 12.9279,
    currentLng: 77.6271,
  }),
  vehicleRow({
    id: 'V7',
    make: 'Hyundai',
    model: 'i20',
    type: 'hatchback',
    transmission: 'manual',
    pricePerDay: 1200,
    currentLat: 12.9698,
    currentLng: 77.598,
  }),
  vehicleRow({
    id: 'V8',
    make: 'Mahindra',
    model: 'XUV700',
    type: 'suv',
    transmission: 'automatic',
    pricePerDay: 4500,
    currentLat: 12.9141,
    currentLng: 77.6101,
  }),
  vehicleRow({
    id: 'V9',
    make: 'MG',
    model: 'Hector',
    type: 'suv',
    transmission: 'automatic',
    pricePerDay: 3000,
    currentLat: 13.001,
    currentLng: 77.571,
  }),
  vehicleRow({
    id: 'V10',
    make: 'Toyota',
    model: 'Fortuner',
    type: 'suv',
    transmission: 'automatic',
    pricePerDay: 5500,
    status: 'maintenance',
    currentLat: 12.935,
    currentLng: 77.535,
  }),
];

async function errorsFor(plain: Record<string, unknown>) {
  const instance = plainToInstance(SearchVehiclesQuery, plain);
  return validate(instance);
}

describe('VehiclesService', () => {
  const findMany = vi.fn();
  let service: VehiclesService;

  beforeEach(() => {
    findMany.mockReset();
    service = new VehiclesService({
      vehicle: { findMany },
    } as unknown as PrismaService);
  });

  it('returns Creta, Hector, Seltos, Nexon for the demo filter nearest first', async () => {
    findMany.mockImplementation(async ({ where }) => {
      expect(where.status).toEqual({ not: 'maintenance' });
      expect(where.type).toBe('suv');
      expect(where.transmission).toBe('automatic');
      expect(where.pricePerDay).toEqual({ lte: 3000 });
      return seedVehicles.filter(
        (v) =>
          v.status !== 'maintenance' &&
          v.type === 'suv' &&
          v.transmission === 'automatic' &&
          v.pricePerDay <= 3000,
      );
    });

    const results = await service.search({
      lat: 12.9756,
      lng: 77.6068,
      radiusKm: 10,
      type: 'suv',
      transmission: 'automatic',
      maxPricePerDay: 3000,
    });

    expect(results.map((v) => v.model)).toEqual([
      'Creta',
      'Hector',
      'Seltos',
      'Nexon',
    ]);
    expect(results.map((v) => v.id)).toEqual(['V1', 'V9', 'V2', 'V6']);
    expect(results.every((v) => typeof v.distanceKm === 'number')).toBe(true);
    expect(results[0]?.distanceKm).toBe(3.8);
    expect(
      results.every((v) => !('anchorLat' in v) && !('anchorLng' in v)),
    ).toBe(true);
    expect(results.every((v) => !('reservations' in v))).toBe(true);
  });

  it('omits Fortuner (maintenance) even within a wide radius', async () => {
    findMany.mockImplementation(async ({ where }) => {
      expect(where.status).toEqual({ not: 'maintenance' });
      return seedVehicles.filter((v) => v.status !== 'maintenance');
    });

    const results = await service.search({
      lat: 12.9756,
      lng: 77.6068,
      radiusKm: 50,
    });

    expect(results.some((v) => v.model === 'Fortuner' || v.id === 'V10')).toBe(
      false,
    );
    expect(findMany).toHaveBeenCalled();
  });

  it('excludes a confirmed overlap, keeps cancelled and touching endpoints', async () => {
    const startDate = '2026-10-01T00:00:00.000Z';
    const endDate = '2026-10-05T00:00:00.000Z';
    findMany.mockImplementation(async ({ where }) => {
      expect(where.reservations).toEqual({
        none: {
          status: 'confirmed',
          startAt: { lt: new Date(endDate) },
          endAt: { gt: new Date(startDate) },
        },
      });
      return seedVehicles.filter(
        (v) => v.status !== 'maintenance' && v.id !== 'V1',
      );
    });

    const results = await service.search({
      lat: 12.9756,
      lng: 77.6068,
      radiusKm: 10,
      type: 'suv',
      transmission: 'automatic',
      maxPricePerDay: 3000,
      startDate,
      endDate,
    });

    expect(results.some((v) => v.model === 'Creta')).toBe(false);
    expect(results.some((v) => v.model === 'Seltos')).toBe(true);
  });

  it('keeps a vehicle at the rounded radius and drops one above it', async () => {
    findMany.mockResolvedValue([
      vehicleRow({
        id: 'EQ',
        model: 'OnRadius',
        currentLat: latOffsetKm(10),
        currentLng: 0,
      }),
      vehicleRow({
        id: 'AB',
        model: 'AboveRadius',
        currentLat: latOffsetKm(10.05),
        currentLng: 0,
      }),
    ]);

    const results = await service.search({
      lat: 0,
      lng: 0,
      radiusKm: 10,
    });

    expect(results.map((v) => v.id)).toEqual(['EQ']);
    expect(results[0]?.distanceKm).toBe(10);
  });

  it('defaults radiusKm to 10 and excludes vehicles beyond it', async () => {
    findMany.mockResolvedValue([
      vehicleRow({
        id: 'NEAR',
        model: 'Near',
        currentLat: latOffsetKm(9),
        currentLng: 0,
      }),
      vehicleRow({
        id: 'FAR',
        model: 'Far',
        currentLat: latOffsetKm(11),
        currentLng: 0,
      }),
    ]);

    const results = await service.search({ lat: 0, lng: 0 });

    expect(results.map((v) => v.id)).toEqual(['NEAR']);
    expect(results.every((v) => v.distanceKm <= 10)).toBe(true);
  });

  it('filters on the rounded kilometre so 10.04 at radius 10 stays', () => {
    expect(roundDistanceKm(10.04)).toBe(10);
    expect(roundDistanceKm(10.05)).toBe(10.1);
  });
});

describe('SearchVehiclesQuery validation', () => {
  it('rejects missing lat, lone startDate, and radiusKm 51', async () => {
    expect((await errorsFor({ lng: 77.6068 })).length).toBeGreaterThan(0);
    expect(
      (
        await errorsFor({
          lat: 12.9756,
          lng: 77.6068,
          startDate: '2026-10-01T00:00:00.000Z',
        })
      ).length,
    ).toBeGreaterThan(0);
    expect(
      (await errorsFor({ lat: 12.9756, lng: 77.6068, radiusKm: 51 })).length,
    ).toBeGreaterThan(0);
  });

  it('rejects date-only strings and endDate not after startDate', async () => {
    expect(
      (
        await errorsFor({
          lat: 12.9756,
          lng: 77.6068,
          startDate: '2026-10-01',
          endDate: '2026-10-05',
        })
      ).length,
    ).toBeGreaterThan(0);
    expect(
      (
        await errorsFor({
          lat: 12.9756,
          lng: 77.6068,
          startDate: '2026-10-05T00:00:00.000Z',
          endDate: '2026-10-01T00:00:00.000Z',
        })
      ).length,
    ).toBeGreaterThan(0);
  });

  it('accepts numeric strings and offset instants', async () => {
    expect(
      await errorsFor({
        lat: '12.9756',
        lng: '77.6068',
        radiusKm: '10',
        maxPricePerDay: '3000',
        startDate: '2026-10-01T10:00:00+05:30',
        endDate: '2026-10-02T10:00:00+05:30',
      }),
    ).toEqual([]);
  });

  it('rejects blank lat, blank maxPricePerDay, and rolled calendar dates', async () => {
    expect(
      (await errorsFor({ lat: '', lng: 77.6068 })).length,
    ).toBeGreaterThan(0);
    expect(
      (
        await errorsFor({
          lat: 12.9756,
          lng: 77.6068,
          maxPricePerDay: '',
        })
      ).length,
    ).toBeGreaterThan(0);
    expect(
      (
        await errorsFor({
          lat: 12.9756,
          lng: 77.6068,
          startDate: '2026-02-31T00:00:00.000Z',
          endDate: '2026-03-05T00:00:00.000Z',
        })
      ).length,
    ).toBeGreaterThan(0);
  });

  it('rejects lone endDate, equal dates, unknown key, negative price, and bad type', async () => {
    expect(
      (
        await errorsFor({
          lat: 12.9756,
          lng: 77.6068,
          endDate: '2026-10-05T00:00:00.000Z',
        })
      ).length,
    ).toBeGreaterThan(0);
    expect(
      (
        await errorsFor({
          lat: 12.9756,
          lng: 77.6068,
          startDate: '2026-10-01T00:00:00.000Z',
          endDate: '2026-10-01T00:00:00.000Z',
        })
      ).length,
    ).toBeGreaterThan(0);
    expect(
      (
        await errorsFor({
          lat: 12.9756,
          lng: 77.6068,
          maxPricePerDay: -1,
        })
      ).length,
    ).toBeGreaterThan(0);
    expect(
      (
        await errorsFor({
          lat: 12.9756,
          lng: 77.6068,
          type: 'truck',
        })
      ).length,
    ).toBeGreaterThan(0);

    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    await expect(
      pipe.transform(
        { lat: 12.9756, lng: 77.6068, unknownKey: 'x' },
        { type: 'query', metatype: SearchVehiclesQuery },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('bad search query', () => {
  it('returns VALIDATION_ERROR and does not query vehicles', async () => {
    const findMany = vi.fn();
    new VehiclesService({
      vehicle: { findMany },
    } as unknown as PrismaService);
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    const cases = [
      { lng: 77.6068 },
      { lat: 12.9756, lng: 77.6068, startDate: '2026-10-01T00:00:00.000Z' },
      { lat: 12.9756, lng: 77.6068, radiusKm: 51 },
    ];

    for (const plain of cases) {
      await expect(
        pipe.transform(plain, { type: 'query', metatype: SearchVehiclesQuery }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(findMany).not.toHaveBeenCalled();

    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    new ValidationErrorFilter().catch(new BadRequestException('ignored'), {
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    } as never);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Search query is not valid.',
    });
  });
});

describe('search without a token', () => {
  it('rejects with UNAUTHORIZED before search runs', async () => {
    const verifyAsync = vi.fn();
    const guard = new JwtAuthGuard(
      { verifyAsync } as unknown as JwtService,
      new Reflector(),
    );
    const context = {
      getHandler: () => VehiclesController.prototype.search,
      getClass: () => VehiclesController,
      switchToHttp: () => ({
        getRequest: () => ({ headers: {} }),
      }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: {
        statusCode: 401,
        code: 'UNAUTHORIZED',
        message: 'Missing or invalid Authorization header.',
      },
    });
    expect(verifyAsync).not.toHaveBeenCalled();
  });
});

describe('vehicle detail, availability, and price', () => {
  const findUnique = vi.fn();
  const reservationFindMany = vi.fn();
  let service: VehiclesService;

  beforeEach(() => {
    findUnique.mockReset();
    reservationFindMany.mockReset();
    service = new VehiclesService({
      vehicle: { findUnique },
      reservation: { findMany: reservationFindMany },
    } as unknown as PrismaService);
  });

  it('returns the public vehicle and distance, without anchors', async () => {
    findUnique.mockResolvedValue(
      vehicleRow({
        id: 'V1',
        currentLat: 12.9756,
        currentLng: 77.6068,
        anchorLat: 1,
        anchorLng: 2,
      }),
    );

    const result = await service.details('V1', { lat: 12.9756, lng: 77.6068 });

    expect(result.id).toBe('V1');
    expect(result.distanceKm).toBe(0);
    expect(result).not.toHaveProperty('anchorLat');
    expect(result).not.toHaveProperty('anchorLng');
  });

  it('lists confirmed overlap ids and rejects a maintenance vehicle', async () => {
    const startDate = '2026-10-02T04:30:00.000Z';
    const endDate = '2026-10-03T04:30:00.000Z';
    findUnique.mockResolvedValue(vehicleRow({ id: 'V1' }));
    reservationFindMany.mockResolvedValue([{ id: 'res-9' }]);

    await expect(service.availability('V1', startDate, endDate)).resolves.toEqual({
      available: false,
      conflicts: ['res-9'],
    });
    expect(reservationFindMany).toHaveBeenCalledWith({
      where: {
        vehicleId: 'V1',
        status: 'confirmed',
        startAt: { lt: new Date(endDate) },
        endAt: { gt: new Date(startDate) },
      },
      select: { id: true },
    });

    findUnique.mockResolvedValue(
      vehicleRow({ id: 'V10', status: 'maintenance' }),
    );
    reservationFindMany.mockResolvedValue([]);
    await expect(service.availability('V10', startDate, endDate)).resolves.toEqual({
      available: false,
      conflicts: [],
    });
  });

  it('prices tomorrow as one day and does not add the deposit', async () => {
    findUnique.mockResolvedValue(
      vehicleRow({ id: 'V1', pricePerDay: 2800, securityDeposit: 5000 }),
    );

    await expect(
      service.price(
        'V1',
        '2026-10-02T04:30:00.000Z',
        '2026-10-03T04:30:00.000Z',
      ),
    ).resolves.toEqual({
      dayCount: 1,
      pricePerDay: 2800,
      totalPrice: 2800,
      securityDeposit: 5000,
      currency: 'INR',
    });

    await expect(
      service.price(
        'V1',
        '2026-10-02T04:30:00.000Z',
        '2026-10-03T05:30:00.000Z',
      ),
    ).resolves.toMatchObject({ dayCount: 2, totalPrice: 5600 });
  });

  it('throws VEHICLE_NOT_FOUND for an unknown id', async () => {
    findUnique.mockResolvedValue(null);

    await expect(service.details('missing')).rejects.toMatchObject({
      response: {
        statusCode: 404,
        code: 'VEHICLE_NOT_FOUND',
        message: 'Vehicle was not found.',
      },
    });
    await expect(
      service.availability(
        'missing',
        '2026-10-02T04:30:00.000Z',
        '2026-10-03T04:30:00.000Z',
      ),
    ).rejects.toBeInstanceOf(VehicleNotFoundException);
    await expect(
      service.price(
        'missing',
        '2026-10-02T04:30:00.000Z',
        '2026-10-03T04:30:00.000Z',
      ),
    ).rejects.toBeInstanceOf(VehicleNotFoundException);
    expect(reservationFindMany).not.toHaveBeenCalled();
  });
});

describe('vehicle route validation', () => {
  async function dateErrors(plain: Record<string, unknown>) {
    return validate(plainToInstance(VehicleDateRangeDto, plain));
  }

  async function detailErrors(plain: Record<string, unknown>) {
    return validate(plainToInstance(VehicleDetailsQuery, plain));
  }

  it('requires a real ISO instant pair for availability and price', async () => {
    expect(await dateErrors({})).not.toEqual([]);
    expect(
      await dateErrors({
        startDate: '2026-10-02',
        endDate: '2026-10-03',
      }),
    ).not.toEqual([]);
    expect(
      await dateErrors({
        startDate: '2026-10-03T04:30:00.000Z',
        endDate: '2026-10-02T04:30:00.000Z',
      }),
    ).not.toEqual([]);
    expect(
      await dateErrors({
        startDate: '2026-10-02T04:30:00.000Z',
        endDate: '2026-10-03T04:30:00.000Z',
      }),
    ).toEqual([]);
  });

  it('accepts coordinates together and rejects a single one', async () => {
    expect(await detailErrors({})).toEqual([]);
    expect(await detailErrors({ lat: 12.9756, lng: 77.6068 })).toEqual([]);
    expect((await detailErrors({ lat: 12.9756 })).length).toBeGreaterThan(0);
  });
});

describe('VehiclesController', () => {
  it('applies ValidationErrorFilter', () => {
    const filters = Reflect.getMetadata(
      EXCEPTION_FILTERS_METADATA,
      VehiclesController,
    ) as unknown[];
    expect(filters).toEqual(expect.arrayContaining([ValidationErrorFilter]));
  });

  it('passes coordinates and dates into the service', async () => {
    const details = vi.fn().mockResolvedValue({ id: 'V1' });
    const availability = vi.fn().mockResolvedValue({ available: true });
    const price = vi.fn().mockResolvedValue({ dayCount: 1 });
    const controller = new VehiclesController({
      details,
      availability,
      price,
    } as unknown as VehiclesService);
    const startDate = '2026-10-02T04:30:00.000Z';
    const endDate = '2026-10-03T04:30:00.000Z';

    await controller.details('V1', { lat: 12.9756, lng: 77.6068 });
    expect(details).toHaveBeenCalledWith('V1', { lat: 12.9756, lng: 77.6068 });

    await controller.availability('V1', { startDate, endDate });
    expect(availability).toHaveBeenCalledWith('V1', startDate, endDate);

    await controller.price('V1', { startDate, endDate });
    expect(price).toHaveBeenCalledWith('V1', startDate, endDate);
  });

  it('returns VEHICLE_NOT_FOUND from the detail route', async () => {
    const controller = new VehiclesController({
      details: () => Promise.reject(new VehicleNotFoundException()),
    } as unknown as VehiclesService);

    await expect(controller.details('missing', {})).rejects.toMatchObject({
      response: { statusCode: 404, code: 'VEHICLE_NOT_FOUND' },
    });
  });
});

describe('ValidationErrorFilter', () => {
  it('maps BadRequestException to VALIDATION_ERROR', () => {
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
      }),
    };

    new ValidationErrorFilter().catch(
      new BadRequestException('ignored'),
      host as never,
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Search query is not valid.',
    });
  });

  it('maps availability and price failures to Dates are not valid', () => {
    for (const url of ['/api/vehicles/V1/availability', '/api/vehicles/V1/price']) {
      const json = vi.fn();
      const status = vi.fn().mockReturnValue({ json });
      new ValidationErrorFilter().catch(new BadRequestException('ignored'), {
        switchToHttp: () => ({
          getResponse: () => ({ status }),
          getRequest: () => ({ originalUrl: url }),
        }),
      } as never);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Dates are not valid.',
      });
    }
  });
});
