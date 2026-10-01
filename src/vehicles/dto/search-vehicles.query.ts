import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  Matches,
  Max,
  Min,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';

export const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Convert numeric query strings. Leave blanks so @IsNumber/@IsInt reject them. */
export function queryNumber({ value }: { value: unknown }): unknown {
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value === 'string') {
    if (value.trim() === '') {
      return value;
    }
    return Number(value);
  }
  return value;
}

function offsetMinutes(iso: string): number | null {
  if (iso.endsWith('Z')) {
    return 0;
  }
  const match = /([+-])(\d{2}):(\d{2})$/.exec(iso);
  if (!match) {
    return null;
  }
  const sign = match[1] === '+' ? 1 : -1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

/** True when the wall-clock calendar day in the string is a real day. */
export function calendarDayIsReal(iso: string): boolean {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T/.exec(iso);
  const offset = offsetMinutes(iso);
  const ms = Date.parse(iso);
  if (!parts || offset === null || Number.isNaN(ms)) {
    return false;
  }
  const wall = new Date(ms + offset * 60 * 1000);
  const y = wall.getUTCFullYear();
  const m = String(wall.getUTCMonth() + 1).padStart(2, '0');
  const d = String(wall.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}` === `${parts[1]}-${parts[2]}-${parts[3]}`;
}

@ValidatorConstraint({ name: 'searchDatePair', async: false })
export class SearchDatePairConstraint implements ValidatorConstraintInterface {
  validate(_: unknown, args: ValidationArguments): boolean {
    const query = args.object as SearchVehiclesQuery;
    const hasStart = query.startDate !== undefined && query.startDate !== null;
    const hasEnd = query.endDate !== undefined && query.endDate !== null;
    if (!hasStart && !hasEnd) {
      return true;
    }
    if (hasStart !== hasEnd) {
      return false;
    }
    if (
      !calendarDayIsReal(query.startDate!) ||
      !calendarDayIsReal(query.endDate!)
    ) {
      return false;
    }
    const start = Date.parse(query.startDate!);
    const end = Date.parse(query.endDate!);
    if (Number.isNaN(start) || Number.isNaN(end)) {
      return false;
    }
    return end > start;
  }

  defaultMessage(): string {
    return 'Search query is not valid.';
  }
}

export class SearchVehiclesQuery {
  @Transform(queryNumber)
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @Transform(queryNumber)
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;

  @IsOptional()
  @Transform(queryNumber)
  @IsNumber()
  @IsPositive()
  @Max(50)
  radiusKm?: number;

  @IsOptional()
  @IsIn(['suv', 'sedan', 'hatchback', 'muv'])
  type?: 'suv' | 'sedan' | 'hatchback' | 'muv';

  @IsOptional()
  @IsIn(['automatic', 'manual'])
  transmission?: 'automatic' | 'manual';

  @IsOptional()
  @Transform(queryNumber)
  @IsInt()
  @Min(0)
  maxPricePerDay?: number;

  @IsOptional()
  @Matches(ISO_INSTANT)
  @Validate(SearchDatePairConstraint)
  startDate?: string;

  @IsOptional()
  @Matches(ISO_INSTANT)
  @Validate(SearchDatePairConstraint)
  endDate?: string;
}
