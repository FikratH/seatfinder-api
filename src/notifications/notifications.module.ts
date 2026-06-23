import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { PushModule } from '../push/push.module';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [PushModule, RealtimeModule],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
