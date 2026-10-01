import {
  Matches,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { calendarDayIsReal, ISO_INSTANT } from './search-vehicles.query.js';

@ValidatorConstraint({ name: 'requiredIsoDatePair', async: false })
export class RequiredIsoDatePairConstraint implements ValidatorConstraintInterface {
  validate(_: unknown, args: ValidationArguments): boolean {
    const query = args.object as { startDate?: string; endDate?: string };
    if (!query.startDate || !query.endDate) {
      return false;
    }
    if (
      !calendarDayIsReal(query.startDate) ||
      !calendarDayIsReal(query.endDate)
    ) {
      return false;
    }
    const start = Date.parse(query.startDate);
    const end = Date.parse(query.endDate);
    if (Number.isNaN(start) || Number.isNaN(end)) {
      return false;
    }
    return end > start;
  }

  defaultMessage(): string {
    return 'Dates are not valid.';
  }
}

export class VehicleDateRangeDto {
  @Matches(ISO_INSTANT)
  @Validate(RequiredIsoDatePairConstraint)
  startDate!: string;

  @Matches(ISO_INSTANT)
  @Validate(RequiredIsoDatePairConstraint)
  endDate!: string;
}
