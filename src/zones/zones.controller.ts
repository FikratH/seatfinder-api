import { Controller, Get, Post, Put, Delete, Param, Query, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ZonesService } from './zones.service';

@ApiTags('zones')
@Controller('zones')
export class ZonesController {
  constructor(private zonesService: ZonesService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Get all zones with occupancy' })
  @ApiQuery({ name: 'buildingId', required: false })
  @ApiQuery({ name: 'floorId', required: false })
  findAll(
    @Query('buildingId') buildingId?: string,
    @Query('floorId') floorId?: string,
  ) {
    return this.zonesService.findAll(buildingId, floorId);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Get(':id')
  @ApiOperation({ summary: 'Get zone details (occupant identity only visible to admins)' })
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    const isAdmin = user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN';
    return this.zonesService.findOne(id, isAdmin);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @Post()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new zone' })
  create(@Body() data: { name: string; floorId: string; capacity?: number }) {
    return this.zonesService.create(data);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @Put(':id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a zone' })
  update(@Param('id') id: string, @Body() data: { name?: string; floorId?: string; capacity?: number }) {
    return this.zonesService.update(id, data);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @Delete(':id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete a zone' })
  remove(@Param('id') id: string) {
    return this.zonesService.remove(id);
  }
}
