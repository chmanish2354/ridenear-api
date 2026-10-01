import { IsString, MinLength } from 'class-validator';
import { VehicleDateRangeDto } from '../../vehicles/dto/vehicle-date-range.js';

export class CreateReservationDto extends VehicleDateRangeDto {
  @IsString()
  @MinLength(1)
  vehicleId!: string;
}
