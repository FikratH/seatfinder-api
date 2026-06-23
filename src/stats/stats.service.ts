import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class StatsService {
  constructor(private prisma: PrismaService) {}

  async getOverallStats() {
    const [
      totalUsers,
      totalZones,
      totalSeats,
      activeCheckins,
      todayCheckins,
      completedCheckins,
    ] = await Promise.all([
      // Total users
      this.prisma.user.count(),
      
      // Total zones
      this.prisma.zone.count({ where: { isActive: true } }),
      
      // Total seats
      this.prisma.seat.count({ where: { isActive: true } }),
      
      // Active check-ins
      this.prisma.checkin.count({ where: { endedAt: null } }),
      
      // Today's check-ins
      this.prisma.checkin.count({
        where: {
          startedAt: {
            gte: new Date(new Date().setHours(0, 0, 0, 0)),
          },
        },
      }),
      
      // Get completed check-ins for average session time
      this.prisma.checkin.findMany({
        where: {
          endedAt: { not: null },
          startedAt: {
            gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // Last 7 days
          },
        },
        select: {
          startedAt: true,
          endedAt: true,
        },
      }),
    ]);

    const occupancyRate = totalSeats > 0 ? (activeCheckins / totalSeats) * 100 : 0;
    
    // Calculate average session time in minutes
    let avgSessionMinutes = 0;
    if (completedCheckins.length > 0) {
      const totalMinutes = completedCheckins.reduce((sum, checkin) => {
        const duration = new Date(checkin.endedAt!).getTime() - new Date(checkin.startedAt).getTime();
        return sum + duration / (1000 * 60); // Convert to minutes
      }, 0);
      avgSessionMinutes = Math.round(totalMinutes / completedCheckins.length);
    }

    return {
      totalUsers,
      totalZones,
      totalSeats,
      activeCheckins,
      todayCheckins,
      occupancyRate: Math.round(occupancyRate * 10) / 10,
      avgSessionMinutes, // Average time users stay checked in
    };
  }

  async getZoneStats() {
    const zones = await this.prisma.zone.findMany({
      where: { isActive: true },
      include: {
        floor: {
          include: {
            building: true,
          },
        },
        seats: {
          where: { isActive: true },
        },
        checkins: {
          where: { endedAt: null },
        },
      },
    });

    return zones.map((zone) => ({
      id: zone.id,
      name: zone.name,
      building: zone.floor.building.name,
      floor: zone.floor.name || `Floor ${zone.floor.index}`,
      totalSeats: zone.seats.length,
      activeCheckins: zone.checkins.length,
      occupancyRate: zone.seats.length > 0 
        ? Math.round((zone.checkins.length / zone.seats.length) * 100 * 10) / 10 
        : 0,
    }));
  }

  async getRecentActivity(limit: number = 10) {
    const recentCheckins = await this.prisma.checkin.findMany({
      take: limit,
      orderBy: { startedAt: 'desc' },
      include: {
        user: {
          select: {
            email: true,
          },
        },
        zone: {
          include: {
            floor: {
              include: {
                building: true,
              },
            },
          },
        },
        seat: {
          select: {
            label: true,
          },
        },
      },
    });

    return recentCheckins.map((checkin) => ({
      id: checkin.id,
      userEmail: checkin.user.email,
      zoneName: checkin.zone.name,
      building: checkin.zone.floor.building.name,
      seatLabel: checkin.seat?.label,
      startedAt: checkin.startedAt,
      endedAt: checkin.endedAt,
      duration: checkin.endedAt 
        ? Math.round((new Date(checkin.endedAt).getTime() - new Date(checkin.startedAt).getTime()) / 60000) 
        : null,
    }));
  }

  async getUsageStats(days: number = 7) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const checkins = await this.prisma.checkin.findMany({
      where: {
        startedAt: {
          gte: startDate,
        },
      },
      orderBy: {
        startedAt: 'asc',
      },
    });

    // Group by date
    const dailyStats: { [key: string]: number } = {};
    
    checkins.forEach((checkin) => {
      const date = new Date(checkin.startedAt).toISOString().split('T')[0];
      dailyStats[date] = (dailyStats[date] || 0) + 1;
    });

    return Object.entries(dailyStats).map(([date, count]) => ({
      date,
      checkins: count,
    }));
  }

  async getUserStats(userId: string) {
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);

    const [
      allCheckIns,
      thisWeekCheckIns,
      favoriteZones,
      recentCheckIns,
    ] = await Promise.all([
      // All check-ins for the user
      this.prisma.checkin.findMany({
        where: { userId },
        select: {
          startedAt: true,
          endedAt: true,
          extendedCount: true,
        },
      }),

      // This week's check-ins
      this.prisma.checkin.count({
        where: {
          userId,
          startedAt: { gte: startOfWeek },
        },
      }),

      // Favorite zones (most visited)
      this.prisma.checkin.groupBy({
        by: ['zoneId'],
        where: { userId },
        _count: { zoneId: true },
        orderBy: { _count: { zoneId: 'desc' } },
        take: 3,
      }),

      // Recent check-ins
      this.prisma.checkin.findMany({
        where: { userId },
        orderBy: { startedAt: 'desc' },
        take: 5,
        include: {
          zone: {
            include: {
              floor: {
                include: {
                  building: true,
                },
              },
            },
          },
          seat: true,
        },
      }),
    ]);

    // Calculate total minutes and average session
    const completedCheckIns = allCheckIns.filter(c => c.endedAt);
    const totalMinutes = completedCheckIns.reduce((sum, c) => {
      const duration = (new Date(c.endedAt!).getTime() - new Date(c.startedAt).getTime()) / 60000;
      return sum + duration;
    }, 0);

    const avgSessionMinutes = completedCheckIns.length > 0 
      ? Math.round(totalMinutes / completedCheckIns.length) 
      : 0;

    // This week's total minutes
    const thisWeekCheckInsData = await this.prisma.checkin.findMany({
      where: {
        userId,
        startedAt: { gte: startOfWeek },
        endedAt: { not: null },
      },
      select: {
        startedAt: true,
        endedAt: true,
      },
    });

    const thisWeekMinutes = thisWeekCheckInsData.reduce((sum, c) => {
      const duration = (new Date(c.endedAt!).getTime() - new Date(c.startedAt).getTime()) / 60000;
      return sum + duration;
    }, 0);

    // Longest session
    const longestSession = completedCheckIns.reduce((max, c) => {
      const duration = (new Date(c.endedAt!).getTime() - new Date(c.startedAt).getTime()) / 60000;
      return Math.max(max, duration);
    }, 0);

    // Total extensions used
    const extensionsUsed = allCheckIns.reduce((sum, c) => sum + c.extendedCount, 0);

    // Get zone details for favorites
    const favoriteZonesDetails = await Promise.all(
      favoriteZones.map(async (fz) => {
        const zone = await this.prisma.zone.findUnique({
          where: { id: fz.zoneId },
          include: {
            floor: {
              include: {
                building: true,
              },
            },
          },
        });
        return {
          id: zone?.id,
          name: zone?.name,
          building: zone?.floor.building.name,
          floor: zone?.floor.name || `Floor ${zone?.floor.index}`,
          checkInCount: fz._count.zoneId,
        };
      })
    );

    return {
      totalCheckIns: allCheckIns.length,
      totalMinutes: Math.round(totalMinutes),
      avgSessionMinutes,
      thisWeekCheckIns,
      thisWeekMinutes: Math.round(thisWeekMinutes),
      longestSessionMinutes: Math.round(longestSession),
      extensionsUsed,
      favoriteZones: favoriteZonesDetails,
      recentCheckIns: recentCheckIns.map(c => ({
        id: c.id,
        zoneName: c.zone.name,
        building: c.zone.floor.building.name,
        seatLabel: c.seat?.label || null,
        startedAt: c.startedAt,
        endedAt: c.endedAt,
        durationMinutes: c.endedAt 
          ? Math.round((new Date(c.endedAt).getTime() - new Date(c.startedAt).getTime()) / 60000)
          : null,
      })),
    };
  }
}
