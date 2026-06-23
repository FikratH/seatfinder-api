import { Controller, Post, Get, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { SeatReviewsService } from './seat-reviews.service';
import { IsString, IsInt, Min, Max } from 'class-validator';

class CreateReviewDto {
  @IsString()
  seatId: string;

  @IsString()
  checkinId: string;

  @IsInt()
  @Min(1)
  @Max(5)
  comfort: number;

  @IsInt()
  @Min(1)
  @Max(5)
  lighting: number;

  @IsInt()
  @Min(1)
  @Max(5)
  noise: number;
}

@ApiTags('seat-reviews')
@Controller('seat-reviews')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class SeatReviewsController {
  constructor(private reviewsService: SeatReviewsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a review for a seat after checkout' })
  createReview(@CurrentUser() user: any, @Body() dto: CreateReviewDto) {
    return this.reviewsService.createReview(
      user.userId,
      dto.seatId,
      dto.checkinId,
      dto.comfort,
      dto.lighting,
      dto.noise,
    );
  }

  @Get('seat/:seatId/ratings')
  @ApiOperation({ summary: 'Get average ratings for a seat' })
  getSeatRatings(@Param('seatId') seatId: string) {
    return this.reviewsService.getSeatAverageRatings(seatId);
  }

  @Get('zone/:zoneId/seats-with-ratings')
  @ApiOperation({ summary: 'Get all seats in a zone with their ratings' })
  getZoneSeatsWithRatings(@Param('zoneId') zoneId: string) {
    return this.reviewsService.getSeatsWithRatings(zoneId);
  }

  @Get('can-review/:checkinId')
  @ApiOperation({ summary: 'Check if user can review a specific check-in' })
  canReview(@CurrentUser() user: any, @Param('checkinId') checkinId: string) {
    return this.reviewsService.canUserReviewCheckin(user.userId, checkinId);
  }

  @Get('has-reviewed/:seatId')
  @ApiOperation({ summary: 'Check if user has already reviewed a seat' })
  hasReviewed(@CurrentUser() user: any, @Param('seatId') seatId: string) {
    return this.reviewsService.hasUserReviewedSeat(user.userId, seatId);
  }
}
