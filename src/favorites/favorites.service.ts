import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class FavoritesService {
  constructor(private readonly prisma: PrismaService) {}

  /** List the user's favorited zones with current occupancy. */
  async listForUser(userId: string) {
    const favorites = await this.prisma.favorite.findMany({
      where: { userId },
      include: {
        zone: {
          include: {
            floor: { include: { building: true } },
            seats: { where: { isActive: true } },
            checkins: { where: { endedAt: null } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return favorites.map((f) => {
      const totalSeats = f.zone.seats.length;
      const denominator = totalSeats > 0 ? totalSeats : f.zone.capacity;
      const activeCheckins = f.zone.checkins.length;
      return {
        id: f.id,
        favoritedAt: f.createdAt,
        zone: {
          id: f.zone.id,
          name: f.zone.name,
          building: f.zone.floor.building.name,
          floor: f.zone.floor.name || `Floor ${f.zone.floor.index}`,
          totalSeats,
          activeCheckins,
          availableSeats: Math.max(0, denominator - activeCheckins),
          occupancyRate:
            denominator > 0
              ? Math.min(
                  100,
                  Math.round((activeCheckins / denominator) * 1000) / 10,
                )
              : 0,
        },
      };
    });
  }

  /** Add a zone to favorites. Idempotent: re-adding returns the existing row. */
  async add(userId: string, zoneId: string) {
    const zone = await this.prisma.zone.findUnique({
      where: { id: zoneId },
      select: { id: true, isActive: true },
    });
    if (!zone || !zone.isActive) {
      throw new NotFoundException('Zone not found');
    }

    try {
      return await this.prisma.favorite.create({
        data: { userId, zoneId },
      });
    } catch (err: any) {
      // P2002 = unique violation → user already favorited this zone
      if (err?.code === 'P2002') {
        const existing = await this.prisma.favorite.findUnique({
          where: { userId_zoneId: { userId, zoneId } },
        });
        if (existing) return existing;
        throw new ConflictException('Already favorited');
      }
      throw err;
    }
  }

  async remove(userId: string, zoneId: string) {
    const result = await this.prisma.favorite.deleteMany({
      where: { userId, zoneId },
    });
    return { removed: result.count };
  }

  /** Quick existence check for the heart-toggle UI. */
  async exists(userId: string, zoneId: string) {
    const row = await this.prisma.favorite.findUnique({
      where: { userId_zoneId: { userId, zoneId } },
      select: { id: true },
    });
    return { isFavorite: Boolean(row) };
  }
}
