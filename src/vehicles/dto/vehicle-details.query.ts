import {
  IsNumber,
  IsOptional,
  Max,
  Min,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { queryNumber } from './search-vehicles.query.js';

@ValidatorConstraint({ name: 'optionalCoordinatePair', async: false })
export class OptionalCoordinatePairConstraint
  implements ValidatorConstraintInterface
{
  validate(_: unknown, args: ValidationArguments): boolean {
    const query = args.object as { lat?: number; lng?: number };
    const hasLat = query.lat !== undefined && query.lat !== null;
    const hasLng = query.lng !== undefined && query.lng !== null;
    return hasLat === hasLng;
  }

  defaultMessage(): string {
    return 'Search query is not valid.';
  }
}

export class VehicleDetailsQuery {
  @IsOptional()
  @Transform(queryNumber)
  @IsNumber()
  @Min(-90)
  @Max(90)
  @Validate(OptionalCoordinatePairConstraint)
  lat?: number;

  @IsOptional()
  @Transform(queryNumber)
  @IsNumber()
  @Min(-180)
  @Max(180)
  @Validate(OptionalCoordinatePairConstraint)
  lng?: number;
}
