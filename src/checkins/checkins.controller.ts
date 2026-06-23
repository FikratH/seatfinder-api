import { Controller, Post, Get, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CheckinsService } from './checkins.service';
import { IsString } from 'class-validator';
import { UserRole } from '@prisma/client';

class CreateCheckinDto {
  @IsString()
  qrToken: string;
}

@ApiTags('checkins')
@Controller('checkins')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class CheckinsController {
  constructor(private checkinsService: CheckinsService) {}

  @Post()
  @ApiOperation({ summary: 'Check in to a zone/seat' })
  create(@CurrentUser() user: any, @Body() dto: CreateCheckinDto) {
    return this.checkinsService.create(user.userId, dto.qrToken);
  }

  @Post(':id/checkout')
  @ApiOperation({ summary: 'Check out' })
  checkout(@CurrentUser() user: any, @Param('id') id: string) {
    return this.checkinsService.checkout(id, user.userId);
  }

  @Get('my-active')
  @ApiOperation({ summary: 'Get your active check-in' })
  getActive(@CurrentUser() user: any) {
    return this.checkinsService.getActiveCheckin(user.userId);
  }

  @Post('preview')
  @ApiOperation({ summary: 'Preview QR code information before checking in' })
  preview(@Body() dto: CreateCheckinDto) {
    return this.checkinsService.previewQR(dto.qrToken);
  }

  @Post('extend-session')
  @ApiOperation({ summary: 'Extend current session by 1 hour' })
  extendSession(@CurrentUser() user: any) {
    return this.checkinsService.extendSession(user.userId);
  }

  @Post('pomodoro')
  @ApiOperation({ summary: 'Mark that user started using pomodoro timer' })
  updatePomodoro(@CurrentUser() user: any) {
    return this.checkinsService.updatePomodoroUsage(user.userId);
  }

  @Get('my-statistics')
  @ApiOperation({ summary: 'Get your usage statistics' })
  getStatistics(@CurrentUser() user: any) {
    return this.checkinsService.getUserStatistics(user.userId);
  }

  @Post('check-expired')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Manually trigger auto-checkout of expired sessions (admin only; cron handles this automatically every minute)' })
  checkExpired() {
    return this.checkinsService.checkExpiredSessions();
  }
}
