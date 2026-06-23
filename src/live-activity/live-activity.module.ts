import { Module } from '@nestjs/common';
import { ApnsClient } from './apns.client';
import { LiveActivityService } from './live-activity.service';
import { LiveActivityController } from './live-activity.controller';

@Module({
  providers: [ApnsClient, LiveActivityService],
  controllers: [LiveActivityController],
  exports: [LiveActivityService],
})
export class LiveActivityModule {}
