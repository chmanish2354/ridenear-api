import { Module } from '@nestjs/common';
import { ReservationsModule } from '../reservations/reservations.module.js';
import { VehiclesModule } from '../vehicles/vehicles.module.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';

@Module({
  imports: [VehiclesModule, ReservationsModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
