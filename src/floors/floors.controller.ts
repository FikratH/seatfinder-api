import { Controller, Get, Post, Put, Delete, Param, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { FloorsService } from './floors.service';

@ApiTags('floors')
@Controller('floors')
export class FloorsController {
  constructor(private floorsService: FloorsService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Get all floors' })
  findAll() {
    return this.floorsService.findAll();
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Get floor details' })
  findOne(@Param('id') id: string) {
    return this.floorsService.findOne(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @Post()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new floor' })
  create(@Body() data: { buildingId: string; index: number; name?: string }) {
    return this.floorsService.create(data);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @Put(':id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a floor' })
  update(@Param('id') id: string, @Body() data: { buildingId?: string; index?: number; name?: string }) {
    return this.floorsService.update(id, data);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @Delete(':id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete a floor' })
  remove(@Param('id') id: string) {
    return this.floorsService.remove(id);
  }
}
