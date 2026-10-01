import { Module } from '@nestjs/common';
import { VehiclesModule } from '../vehicles/vehicles.module.js';
import { ReservationsController } from './reservations.controller.js';
import { ReservationsService } from './reservations.service.js';

@Module({
  imports: [VehiclesModule],
  controllers: [ReservationsController],
  providers: [ReservationsService],
  exports: [ReservationsService],
})
export class ReservationsModule {}
