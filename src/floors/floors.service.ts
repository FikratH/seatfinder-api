import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class FloorsService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.floor.findMany({
      where: { isActive: true },
      include: {
        building: true,
      },
      orderBy: [{ building: { name: 'asc' } }, { index: 'asc' }],
    });
  }

  async findOne(id: string) {
    return this.prisma.floor.findUnique({
      where: { id },
      include: {
        building: true,
        zones: {
          where: { isActive: true },
        },
      },
    });
  }

  async create(data: { buildingId: string; index: number; name?: string }) {
    return this.prisma.floor.create({
      data: {
        buildingId: data.buildingId,
        index: data.index,
        name: data.name,
        isActive: true,
      },
      include: {
        building: true,
      },
    });
  }

  async update(id: string, data: { buildingId?: string; index?: number; name?: string }) {
    return this.prisma.floor.update({
      where: { id },
      data,
      include: {
        building: true,
      },
    });
  }

  async remove(id: string) {
    // Soft delete
    return this.prisma.floor.update({
      where: { id },
      data: { isActive: false },
    });
  }
}
