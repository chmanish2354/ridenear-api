import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { GpsService } from './gps.service.js';
import { RealtimeService } from './realtime.js';

@Module({
  imports: [AuthModule],
  providers: [GpsService, RealtimeService],
  exports: [GpsService, RealtimeService],
})
export class TrackingModule {}
