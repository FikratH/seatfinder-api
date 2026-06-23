import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ZonesService {
  constructor(private prisma: PrismaService) {}

  async findAll(buildingId?: string, floorId?: string) {
    const where = buildingId || floorId ? {} : undefined;
    if (floorId) {
      Object.assign(where, { floorId });
    } else if (buildingId) {
      Object.assign(where, { floor: { buildingId } });
    }

    const zones = await this.prisma.zone.findMany({
      where: where ? { ...where, isActive: true } : { isActive: true },
      include: {
        floor: {
          include: {
            building: true,
          },
        },
        checkins: {
          where: {
            endedAt: null,
          },
        },
        seats: {
          where: {
            isActive: true,
          },
        },
      },
      orderBy: [
        { floor: { building: { name: 'asc' } } },
        { floor: { index: 'asc' } },
        { name: 'asc' },
      ],
    });

    return zones.map((zone) => ({
      id: zone.id,
      name: zone.name,
      capacity: zone.capacity,
      totalSeats: zone.seats.length,
      activeCheckins: zone.checkins.length,
      occupancyRate: zone.seats.length > 0 
        ? (zone.checkins.length / zone.seats.length) * 100 
        : (zone.checkins.length / zone.capacity) * 100,
      building: zone.floor.building.name,
      floor: zone.floor.name || `Floor ${zone.floor.index}`,
      floorIndex: zone.floor.index,
    }));
  }

  async findOne(id: string, viewerIsAdmin = false) {
    const zone = await this.prisma.zone.findUnique({
      where: { id },
      include: {
        floor: {
          include: {
            building: true,
          },
        },
        seats: {
          include: {
            checkins: {
              where: {
                endedAt: null,
              },
              include: {
                user: {
                  select: {
                    id: true,
                    email: true,
                  },
                },
              },
            },
            reviews: {
              select: {
                comfort: true,
                lighting: true,
                noise: true,
              },
            },
          },
        },
        checkins: {
          where: {
            endedAt: null,
          },
          include: {
            user: {
              select: {
                id: true,
                email: true,
              },
            },
          },
        },
      },
    });

    if (!zone) {
      return null;
    }

    return {
      id: zone.id,
      name: zone.name,
      capacity: zone.capacity,
      activeCheckins: zone.checkins.length,
      occupancyRate: zone.seats.length > 0
        ? (zone.checkins.length / zone.seats.length) * 100
        : (zone.checkins.length / zone.capacity) * 100,
      building: zone.floor.building.name,
      floor: zone.floor.name || `Floor ${zone.floor.index}`,
      qrCodeUrl: zone.qrCodeUrl,
      seats: zone.seats.map((seat) => {
        // Calculate average ratings
        const reviews = seat.reviews || [];
        const avgComfort = reviews.length > 0 
          ? reviews.reduce((sum, r) => sum + r.comfort, 0) / reviews.length 
          : null;
        const avgLighting = reviews.length > 0 
          ? reviews.reduce((sum, r) => sum + r.lighting, 0) / reviews.length 
          : null;
        const avgNoise = reviews.length > 0 
          ? reviews.reduce((sum, r) => sum + r.noise, 0) / reviews.length 
          : null;
        const overallAvg = avgComfort !== null 
          ? ((avgComfort + avgLighting! + avgNoise!) / 3) 
          : null;

        return {
          id: seat.id,
          label: seat.label,
          checkins: seat.checkins.map((c) => ({
            id: c.id,
            startedAt: c.startedAt,
            // PII redacted for non-admin viewers (privacy / PDPO)
            ...(viewerIsAdmin
              ? { userId: c.userId, user: c.user }
              : {}),
          })),
          ratings: {
            totalReviews: reviews.length,
            averageComfort: avgComfort !== null ? Number(avgComfort.toFixed(1)) : null,
            averageLighting: avgLighting !== null ? Number(avgLighting.toFixed(1)) : null,
            averageNoise: avgNoise !== null ? Number(avgNoise.toFixed(1)) : null,
            overallAverage: overallAvg !== null ? Number(overallAvg.toFixed(1)) : null,
          },
        };
      }),
      checkins: zone.checkins.map((c) => ({
        id: c.id,
        startedAt: c.startedAt,
        // PII redacted for non-admin viewers (privacy / PDPO)
        ...(viewerIsAdmin
          ? { userId: c.userId, userEmail: c.user.email }
          : {}),
      })),
    };
  }

  async create(data: { name: string; floorId: string; capacity?: number }) {
    // Generate unique QR code ID for zone
    const qrCodeId = `zone-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    
    return this.prisma.zone.create({
      data: {
        name: data.name,
        floorId: data.floorId,
        capacity: data.capacity || 0,
        qrCodeId,
        isActive: true,
      },
      include: {
        floor: {
          include: {
            building: true,
          },
        },
      },
    });
  }

  async update(id: string, data: { name?: string; floorId?: string; capacity?: number }) {
    return this.prisma.zone.update({
      where: { id },
      data,
      include: {
        floor: {
          include: {
            building: true,
          },
        },
      },
    });
  }

  async remove(id: string) {
    // Soft delete
    return this.prisma.zone.update({
      where: { id },
      data: { isActive: false },
    });
  }
}
