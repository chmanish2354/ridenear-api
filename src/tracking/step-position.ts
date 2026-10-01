const METERS_PER_DEGREE_LAT = 111320;
const MIN_STEP_METERS = 30;
const MAX_STEP_METERS = 80;
const CLAMP_RADIUS_METERS = 1500;

export type StepVehicle = {
  status: string;
  currentLat: number;
  currentLng: number;
  anchorLat: number;
  anchorLng: number;
};

export function stepPosition(
  vehicle: StepVehicle,
  rng: () => number = Math.random,
): { lat: number; lng: number } | null {
  if (vehicle.status === 'maintenance') {
    return null;
  }

  const bearing = unit(rng()) * Math.PI * 2;
  const distance =
    MIN_STEP_METERS + unit(rng()) * (MAX_STEP_METERS - MIN_STEP_METERS);
  const moved = offsetMeters(
    vehicle.currentLat,
    vehicle.currentLng,
    bearing,
    distance,
  );
  const fromAnchorMeters = distanceMeters(
    vehicle.anchorLat,
    vehicle.anchorLng,
    moved.lat,
    moved.lng,
  );
  if (fromAnchorMeters <= CLAMP_RADIUS_METERS) {
    return moved;
  }

  const back = bearingRadians(
    vehicle.anchorLat,
    vehicle.anchorLng,
    moved.lat,
    moved.lng,
  );
  return offsetMeters(
    vehicle.anchorLat,
    vehicle.anchorLng,
    back,
    CLAMP_RADIUS_METERS,
  );
}

function unit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function offsetMeters(
  lat: number,
  lng: number,
  bearingRadiansValue: number,
  distanceMeters: number,
): { lat: number; lng: number } {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const dLat =
    (distanceMeters * Math.cos(bearingRadiansValue)) / METERS_PER_DEGREE_LAT;
  const dLng =
    cosLat === 0
      ? 0
      : (distanceMeters * Math.sin(bearingRadiansValue)) /
        (METERS_PER_DEGREE_LAT * cosLat);
  return { lat: lat + dLat, lng: lng + dLng };
}

function distanceMeters(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
): number {
  const dLat = (toLat - fromLat) * METERS_PER_DEGREE_LAT;
  const dLng =
    (toLng - fromLng) *
    METERS_PER_DEGREE_LAT *
    Math.cos((fromLat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

function bearingRadians(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
): number {
  const dLat = (toLat - fromLat) * METERS_PER_DEGREE_LAT;
  const dLng =
    (toLng - fromLng) *
    METERS_PER_DEGREE_LAT *
    Math.cos((fromLat * Math.PI) / 180);
  return Math.atan2(dLng, dLat);
}
