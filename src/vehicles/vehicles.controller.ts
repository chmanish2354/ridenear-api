import { Body, Controller, Get, Param, Post, Query, UseFilters } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SearchVehiclesQuery } from './dto/search-vehicles.query.js';
import { VehicleDateRangeDto } from './dto/vehicle-date-range.js';
import { VehicleDetailsQuery } from './dto/vehicle-details.query.js';
import { ValidationErrorFilter } from './validation-error.filter.js';
import { VehiclesService } from './vehicles.service.js';

@ApiTags('vehicles')
@ApiBearerAuth()
@Controller('vehicles')
@UseFilters(ValidationErrorFilter)
export class VehiclesController {
  constructor(private readonly vehiclesService: VehiclesService) {}

  @Get('search')
  search(@Query() query: SearchVehiclesQuery) {
    return this.vehiclesService.search(query);
  }

  @Get(':id/availability')
  availability(@Param('id') id: string, @Query() query: VehicleDateRangeDto) {
    return this.vehiclesService.availability(id, query.startDate, query.endDate);
  }

  @Get(':id')
  details(@Param('id') id: string, @Query() query: VehicleDetailsQuery) {
    const coordinates =
      query.lat !== undefined && query.lng !== undefined
        ? { lat: query.lat, lng: query.lng }
        : undefined;
    return this.vehiclesService.details(id, coordinates);
  }

  @Post(':id/price')
  price(@Param('id') id: string, @Body() body: VehicleDateRangeDto) {
    return this.vehiclesService.price(id, body.startDate, body.endDate);
  }
}
