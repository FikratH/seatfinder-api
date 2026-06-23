import { Body, Controller, Delete, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { PushPlatform } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PushService } from './push.service';

class RegisterPushTokenDto {
  @IsString()
  token: string;

  @IsEnum(PushPlatform)
  @IsOptional()
  platform?: PushPlatform;

  @IsString()
  @IsOptional()
  deviceName?: string;
}

class UnregisterPushTokenDto {
  @IsString()
  token: string;
}

@ApiTags('push')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('push')
export class PushController {
  constructor(private readonly push: PushService) {}

  @Post('tokens')
  @ApiOperation({ summary: 'Register an Expo push token for the current user' })
  async register(@CurrentUser() user: any, @Body() dto: RegisterPushTokenDto) {
    const row = await this.push.registerToken(
      user.userId,
      dto.token,
      dto.platform,
      dto.deviceName,
    );
    return { id: row.id, token: row.token };
  }

  @Delete('tokens')
  @ApiOperation({ summary: 'Unregister an Expo push token (e.g. on logout)' })
  async unregister(@CurrentUser() user: any, @Body() dto: UnregisterPushTokenDto) {
    await this.push.unregisterToken(user.userId, dto.token);
    return { ok: true };
  }
}
