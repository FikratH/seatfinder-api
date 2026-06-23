import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SeatReviewsService {
  constructor(private prisma: PrismaService) {}

  async createReview(
    userId: string,
    seatId: string,
    checkinId: string,
    comfort: number,
    lighting: number,
    noise: number,
  ) {
    // Validate ratings (1-5 stars)
    if ([comfort, lighting, noise].some(rating => rating < 1 || rating > 5)) {
      throw new BadRequestException('Ratings must be between 1 and 5 stars');
    }

    // Verify the check-in belongs to the user and has ended
    const checkin = await this.prisma.checkin.findUnique({
      where: { id: checkinId },
      include: { seat: true },
    });

    if (!checkin) {
      throw new NotFoundException('Check-in not found');
    }

    if (checkin.userId !== userId) {
      throw new BadRequestException('This check-in does not belong to you');
    }

    if (!checkin.endedAt) {
      throw new BadRequestException('Cannot review an active check-in. Please check out first.');
    }

    if (checkin.seatId !== seatId) {
      throw new BadRequestException('Seat mismatch');
    }

    // Check if user already reviewed this seat
    const existingReview = await this.prisma.seatReview.findUnique({
      where: {
        userId_seatId: {
          userId,
          seatId,
        },
      },
    });

    if (existingReview) {
      throw new BadRequestException('You have already reviewed this seat');
    }

    // Create the review
    return this.prisma.seatReview.create({
      data: {
        userId,
        seatId,
        checkinId,
        comfort,
        lighting,
        noise,
      },
      include: {
        seat: {
          select: {
            id: true,
            label: true,
            zone: {
              select: {
                name: true,
              },
            },
          },
        },
      },
    });
  }

  async hasUserReviewedSeat(userId: string, seatId: string) {
    const review = await this.prisma.seatReview.findUnique({
      where: {
        userId_seatId: {
          userId,
          seatId,
        },
      },
    });
    return {
      hasReviewed: !!review,
      seatId,
    };
  }

  async getSeatAverageRatings(seatId: string) {
    const reviews = await this.prisma.seatReview.findMany({
      where: { seatId },
    });

    if (reviews.length === 0) {
      return {
        seatId,
        totalReviews: 0,
        averageComfort: null,
        averageLighting: null,
        averageNoise: null,
        overallAverage: null,
      };
    }

    const avgComfort = reviews.reduce((sum, r) => sum + r.comfort, 0) / reviews.length;
    const avgLighting = reviews.reduce((sum, r) => sum + r.lighting, 0) / reviews.length;
    const avgNoise = reviews.reduce((sum, r) => sum + r.noise, 0) / reviews.length;
    const overall = (avgComfort + avgLighting + avgNoise) / 3;

    return {
      seatId,
      totalReviews: reviews.length,
      averageComfort: Number(avgComfort.toFixed(1)),
      averageLighting: Number(avgLighting.toFixed(1)),
      averageNoise: Number(avgNoise.toFixed(1)),
      overallAverage: Number(overall.toFixed(1)),
    };
  }

  async getSeatsWithRatings(zoneId: string) {
    const seats = await this.prisma.seat.findMany({
      where: { zoneId, isActive: true },
      include: {
        reviews: {
          select: {
            comfort: true,
            lighting: true,
            noise: true,
          },
        },
      },
    });

    return Promise.all(
      seats.map(async (seat) => {
        const ratings = await this.getSeatAverageRatings(seat.id);
        return {
          id: seat.id,
          label: seat.label,
          ratings,
        };
      }),
    );
  }

  async canUserReviewCheckin(userId: string, checkinId: string): Promise<boolean> {
    const checkin = await this.prisma.checkin.findUnique({
      where: { id: checkinId },
      include: { review: true },
    });

    if (!checkin) {
      return false;
    }

    // Can review if: belongs to user, has ended, has a seat, and hasn't been reviewed
    return (
      checkin.userId === userId &&
      checkin.endedAt !== null &&
      checkin.seatId !== null &&
      !checkin.review
    );
  }
}
