import { Module } from '@nestjs/common';
import { CheckinsService } from './checkins.service';
import { CheckinsController } from './checkins.controller';
import { TimeoutService } from './timeout.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { FriendsModule } from '../friends/friends.module';
import { GroupsModule } from '../groups/groups.module';
import { LiveActivityModule } from '../live-activity/live-activity.module';

@Module({
  imports: [RealtimeModule, FriendsModule, GroupsModule, LiveActivityModule],
  controllers: [CheckinsController],
  providers: [CheckinsService, TimeoutService],
})
export class CheckinsModule {}
