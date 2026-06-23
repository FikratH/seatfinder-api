import { Module } from '@nestjs/common';
import { SeatReviewsController } from './seat-reviews.controller';
import { SeatReviewsService } from './seat-reviews.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [SeatReviewsController],
  providers: [SeatReviewsService],
  exports: [SeatReviewsService],
})
export class SeatReviewsModule {}
