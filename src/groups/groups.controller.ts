import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { GroupsService } from './groups.service';

class CreateGroupDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(100)
  maxMembers?: number;
}

class UpdateGroupDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(100)
  maxMembers?: number;
}

class JoinByCodeDto {
  @IsString()
  @MinLength(6)
  @MaxLength(6)
  joinCode: string;
}

class InviteDto {
  @IsString()
  inviteeId: string;
}

@ApiTags('groups')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('groups')
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  // ─── My groups ──────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'List study groups I belong to' })
  list(@CurrentUser() user: any) {
    return this.groups.listMine(user.userId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a study group (caller becomes owner)' })
  create(@CurrentUser() user: any, @Body() dto: CreateGroupDto) {
    return this.groups.create(user.userId, dto);
  }

  @Get('invites')
  @ApiOperation({ summary: 'Pending invites I have received' })
  invites(@CurrentUser() user: any) {
    return this.groups.listMyInvites(user.userId);
  }

  @Post('invites/:id/accept')
  @ApiOperation({ summary: 'Accept a pending invite' })
  acceptInvite(@CurrentUser() user: any, @Param('id') id: string) {
    return this.groups.acceptInvite(user.userId, id);
  }

  @Post('invites/:id/reject')
  @ApiOperation({ summary: 'Reject a pending invite' })
  rejectInvite(@CurrentUser() user: any, @Param('id') id: string) {
    return this.groups.rejectInvite(user.userId, id);
  }

  @Post('join')
  @ApiOperation({ summary: 'Join a group via its 6-char code' })
  joinByCode(@CurrentUser() user: any, @Body() dto: JoinByCodeDto) {
    return this.groups.joinByCode(user.userId, dto.joinCode);
  }

  // ─── Per-group ──────────────────────────────────────────────────────

  @Get(':id')
  @ApiOperation({ summary: 'Group detail with members and live presence' })
  detail(@CurrentUser() user: any, @Param('id') id: string) {
    return this.groups.getDetail(user.userId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update group (owner only)' })
  update(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdateGroupDto,
  ) {
    return this.groups.update(user.userId, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete group (owner only)' })
  delete(@CurrentUser() user: any, @Param('id') id: string) {
    return this.groups.delete(user.userId, id);
  }

  @Post(':id/leave')
  @ApiOperation({ summary: 'Leave a group I belong to' })
  leave(@CurrentUser() user: any, @Param('id') id: string) {
    return this.groups.leave(user.userId, id);
  }

  @Post(':id/invite')
  @ApiOperation({ summary: 'Invite a user to the group (owner/admin)' })
  invite(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: InviteDto,
  ) {
    return this.groups.invite(user.userId, id, dto.inviteeId);
  }

  @Delete(':id/members/:userId')
  @ApiOperation({ summary: 'Kick a member (owner only)' })
  kick(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Param('userId') targetUserId: string,
  ) {
    return this.groups.kick(user.userId, id, targetUserId);
  }
}
