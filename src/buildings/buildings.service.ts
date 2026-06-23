import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BuildingsService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.building.findMany({
      where: { isActive: true },
      include: {
        floors: {
          where: { isActive: true },
          orderBy: { index: 'asc' },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string) {
    return this.prisma.building.findUnique({
      where: { id },
      include: {
        floors: {
          where: { isActive: true },
          include: {
            zones: {
              where: { isActive: true },
              include: {
                checkins: {
                  where: { endedAt: null },
                },
              },
            },
          },
          orderBy: { index: 'asc' },
        },
      },
    });
  }

  async create(data: { name: string }) {
    return this.prisma.building.create({
      data: {
        name: data.name,
        isActive: true,
      },
    });
  }

  async update(id: string, data: { name?: string }) {
    return this.prisma.building.update({
      where: { id },
      data,
    });
  }

  async remove(id: string) {
    // Soft delete
    return this.prisma.building.update({
      where: { id },
      data: { isActive: false },
    });
  }
}
