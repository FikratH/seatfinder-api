import { Body, Controller, Get, NotFoundException, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UsersService, PublicProfile } from './users.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

/**
 * Endpoints scoped to the authenticated user's own profile.
 *
 *   GET   /users/me     → current public profile (safe shape)
 *   PATCH /users/me     → update displayName / avatarColor / bio
 */
@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  async getMe(@CurrentUser() current: { userId: string }): Promise<PublicProfile> {
    const u = await this.users.findById(current.userId);
    if (!u) throw new NotFoundException('User not found');
    return this.users.toPublic(u);
  }

  @Patch('me')
  async updateMe(
    @CurrentUser() current: { userId: string },
    @Body() dto: UpdateProfileDto,
  ): Promise<PublicProfile> {
    return this.users.updateProfile(current.userId, dto);
  }
}
