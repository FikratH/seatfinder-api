import { Controller, Post, Get, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ReportsService } from './reports.service';
import { IsString, IsEnum, IsOptional } from 'class-validator';
import { ReportStatus, ReportType, UserRole } from '@prisma/client';

class CreateReportDto {
  @IsString()
  zoneId: string;

  @IsEnum(ReportType)
  type: ReportType;

  @IsString()
  @IsOptional()
  message?: string;
}

class ResolveReportDto {
  @IsString()
  @IsOptional()
  resolution?: string;
}

@ApiTags('reports')
@Controller('reports')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ReportsController {
  constructor(private reportsService: ReportsService) {}

  @Post()
  @ApiOperation({ summary: 'Submit a report' })
  create(@CurrentUser() user: any, @Body() dto: CreateReportDto) {
    return this.reportsService.create(user.userId, dto);
  }

  @Get('my-reports')
  @ApiOperation({ summary: 'Get your reports' })
  findMy(@CurrentUser() user: any) {
    return this.reportsService.findMyReports(user.userId);
  }

  // ── Admin moderation queue ────────────────────────────────────────────

  @Get()
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'List all reports (admin)' })
  @ApiQuery({ name: 'status', required: false, enum: ReportStatus })
  findAllAdmin(@Query('status') status?: ReportStatus) {
    return this.reportsService.findAllForAdmin(status);
  }

  @Post(':id/resolve')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Mark a report as resolved (admin)' })
  resolve(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: ResolveReportDto,
  ) {
    return this.reportsService.resolve(id, user.userId, dto?.resolution);
  }

  @Post(':id/dismiss')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Dismiss a report (admin)' })
  dismiss(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: ResolveReportDto,
  ) {
    return this.reportsService.dismiss(id, user.userId, dto?.resolution);
  }
}
