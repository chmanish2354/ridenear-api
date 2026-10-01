import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseFilters,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CreateReservationDto } from './dto/create-reservation.dto.js';
import { ReservationValidationErrorFilter } from './reservation-validation-error.filter.js';
import { ReservationsService } from './reservations.service.js';

type AuthedRequest = Request & { user: { id: string } };

@ApiTags('reservations')
@ApiBearerAuth()
@Controller('reservations')
@UseFilters(ReservationValidationErrorFilter)
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Req() request: AuthedRequest, @Body() body: CreateReservationDto) {
    return this.reservations.create(request.user.id, body);
  }

  @Get('me')
  listMine(@Req() request: AuthedRequest) {
    return this.reservations.listMine(request.user.id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@Req() request: AuthedRequest, @Param('id') id: string) {
    return this.reservations.cancel(request.user.id, id);
  }
}
