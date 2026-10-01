import { describe, expect, it } from 'vitest';
import { haversineDistanceKm } from '../vehicles/haversine.js';
import { stepPosition, type StepVehicle } from './step-position.js';

const METERS_PER_DEGREE_LAT = 111320;

function vehicle(partial: Partial<StepVehicle> = {}): StepVehicle {
  return {
    status: 'available',
    currentLat: 12.9716,
    currentLng: 77.5946,
    anchorLat: 12.9716,
    anchorLng: 77.5946,
    ...partial,
  };
}

function projectedMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const dLat = (lat2 - lat1) * METERS_PER_DEGREE_LAT;
  const dLng =
    (lng2 - lng1) *
    METERS_PER_DEGREE_LAT *
    Math.cos((lat1 * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

describe('stepPosition', () => {
  it('moves a non-maintenance vehicle 30–80 m and leaves maintenance in place', () => {
    const north = stepPosition(vehicle(), () => 0);
    expect(north).not.toBeNull();
    expect(
      projectedMeters(
        12.9716,
        77.5946,
        north!.lat,
        north!.lng,
      ),
    ).toBeCloseTo(30, 5);
    expect(north!.lat).toBeGreaterThan(12.9716);
    expect(north!.lng).toBeCloseTo(77.5946, 8);

    const farthest = stepPosition(
      vehicle(),
      (() => {
        const values = [0, 1];
        let index = 0;
        return () => values[index++] ?? 0;
      })(),
    );
    expect(
      projectedMeters(12.9716, 77.5946, farthest!.lat, farthest!.lng),
    ).toBeCloseTo(80, 5);

    const east = stepPosition(
      vehicle(),
      (() => {
        const values = [0.25, 0.4];
        let index = 0;
        return () => values[index++] ?? 0;
      })(),
    );
    const eastMeters = projectedMeters(12.9716, 77.5946, east!.lat, east!.lng);
    expect(eastMeters).toBeGreaterThanOrEqual(30);
    expect(eastMeters).toBeLessThanOrEqual(80);
    expect(east!.lng).toBeGreaterThan(77.5946);

    const original = vehicle({ status: 'maintenance', currentLat: 13, currentLng: 78 });
    expect(stepPosition(original, () => 0.5)).toBeNull();
    expect(original.currentLat).toBe(13);
    expect(original.currentLng).toBe(78);
  });

  it('places a point that would leave the 1.5 km circle back on that circle', () => {
    const anchorLat = 12.9716;
    const anchorLng = 77.5946;
    const currentLat = anchorLat + 1490 / METERS_PER_DEGREE_LAT;
    const stepped = stepPosition(
      vehicle({
        currentLat,
        currentLng: anchorLng,
        anchorLat,
        anchorLng,
      }),
      (() => {
        const values = [0, 1];
        let index = 0;
        return () => values[index++] ?? 0;
      })(),
    );

    expect(stepped).not.toBeNull();
    const unclampedLat = currentLat + 80 / METERS_PER_DEGREE_LAT;
    expect(
      haversineDistanceKm(anchorLat, anchorLng, unclampedLat, anchorLng),
    ).toBeGreaterThan(1.5);
    expect(
      haversineDistanceKm(anchorLat, anchorLng, stepped!.lat, stepped!.lng),
    ).toBeLessThanOrEqual(1.5);
    expect(
      projectedMeters(anchorLat, anchorLng, stepped!.lat, stepped!.lng),
    ).toBeCloseTo(1500, 3);
    expect(stepped!.lng).toBeCloseTo(anchorLng, 6);
  });

  it('pulls a point just over 1500 m back onto the circle', () => {
    const anchorLat = 12.9716;
    const anchorLng = 77.5946;
    const currentLat = anchorLat + 1490 / METERS_PER_DEGREE_LAT;
    const stepped = stepPosition(
      vehicle({
        currentLat,
        currentLng: anchorLng,
        anchorLat,
        anchorLng,
      }),
      () => 0,
    );
    const unclampedLat = currentLat + 30 / METERS_PER_DEGREE_LAT;

    expect(projectedMeters(anchorLat, anchorLng, unclampedLat, anchorLng)).toBeCloseTo(
      1520,
      3,
    );
    expect(
      haversineDistanceKm(anchorLat, anchorLng, unclampedLat, anchorLng),
    ).toBeLessThanOrEqual(1.5);
    expect(stepped).not.toBeNull();
    expect(
      projectedMeters(anchorLat, anchorLng, stepped!.lat, stepped!.lng),
    ).toBeCloseTo(1500, 3);
    expect(stepped!.lng).toBeCloseTo(anchorLng, 6);
  });
});
