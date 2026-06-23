import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';
import { StatsService } from './stats.service';

@ApiTags('stats')
@Controller('stats')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class StatsController {
  constructor(private statsService: StatsService) {}

  @Get('overall')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get overall statistics' })
  getOverall() {
    return this.statsService.getOverallStats();
  }

  @Get('zones')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get zone statistics' })
  getZones() {
    return this.statsService.getZoneStats();
  }

  @Get('recent-activity')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get recent check-in activity' })
  getRecentActivity(@Query('limit') limit?: string) {
    return this.statsService.getRecentActivity(limit ? parseInt(limit) : 10);
  }

  @Get('usage')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get usage statistics over time' })
  getUsage(@Query('days') days?: string) {
    return this.statsService.getUsageStats(days ? parseInt(days) : 7);
  }

  @Get('user')
  @ApiOperation({ summary: 'Get personal user statistics' })
  getUserStats(@CurrentUser() user: any) {
    return this.statsService.getUserStats(user.userId);
  }
}
