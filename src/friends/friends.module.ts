import { Module } from '@nestjs/common';
import { FriendsService } from './friends.service';
import { FriendsController } from './friends.controller';
import { PushModule } from '../push/push.module';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [PushModule, RealtimeModule],
  providers: [FriendsService],
  controllers: [FriendsController],
  exports: [FriendsService],
})
export class FriendsModule {}
