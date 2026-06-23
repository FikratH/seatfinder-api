import { Body, Controller, Delete, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { LiveActivityService } from './live-activity.service';

class RegisterLiveActivityTokenDto {
  @IsString()
  checkinId: string;

  @IsString()
  pushToken: string;

  @IsOptional()
  @IsString()
  frequencyToken?: string;
}

@ApiTags('live-activity')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('live-activity')
export class LiveActivityController {
  constructor(private readonly svc: LiveActivityService) {}

  @Post('tokens')
  @ApiOperation({ summary: 'Register an APNs Live Activity push token for a checkin' })
  register(
    @CurrentUser() user: any,
    @Body() dto: RegisterLiveActivityTokenDto,
  ) {
    return this.svc.registerToken(
      user.userId,
      dto.checkinId,
      dto.pushToken,
      dto.frequencyToken,
    );
  }

  @Delete('tokens/:checkinId')
  @ApiOperation({ summary: 'Unregister Live Activity token (e.g. after manual end)' })
  unregister(@CurrentUser() user: any, @Param('checkinId') checkinId: string) {
    return this.svc.unregisterToken(user.userId, checkinId);
  }
}
