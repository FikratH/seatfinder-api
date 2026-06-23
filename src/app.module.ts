import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { BuildingsModule } from './buildings/buildings.module';
import { FloorsModule } from './floors/floors.module';
import { ZonesModule } from './zones/zones.module';
import { SeatsModule } from './seats/seats.module';
import { CheckinsModule } from './checkins/checkins.module';
import { ReportsModule } from './reports/reports.module';
import { AdminModule } from './admin/admin.module';
import { StatsModule } from './stats/stats.module';
import { SeatReviewsModule } from './seat-reviews/seat-reviews.module';
import { HealthModule } from './health/health.module';
import { RealtimeModule } from './realtime/realtime.module';
import { PushModule } from './push/push.module';
import { FavoritesModule } from './favorites/favorites.module';
import { NotificationsModule } from './notifications/notifications.module';
import { FriendsModule } from './friends/friends.module';
import { GroupsModule } from './groups/groups.module';
import { LiveActivityModule } from './live-activity/live-activity.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ThrottlerModule.forRoot([{
      ttl: parseInt(process.env.RATE_LIMIT_TTL || '60', 10) * 1000,
      limit: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
    }]),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    UsersModule,
    BuildingsModule,
    FloorsModule,
    ZonesModule,
    SeatsModule,
    CheckinsModule,
    ReportsModule,
    AdminModule,
    StatsModule,
    SeatReviewsModule,
    HealthModule,
    RealtimeModule,
    PushModule,
    FavoritesModule,
    NotificationsModule,
    FriendsModule,
    GroupsModule,
    LiveActivityModule,
  ],
})
export class AppModule {}
