import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { FriendsService } from './friends.service';

class SendFriendRequestDto {
  @IsString()
  @MinLength(1)
  toUserId: string;
}

@ApiTags('friends')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('friends')
export class FriendsController {
  constructor(private readonly friends: FriendsService) {}

  @Get('search')
  @ApiOperation({ summary: 'Search users to add as friends' })
  search(@CurrentUser() user: any, @Query('q') q: string) {
    return this.friends.searchUsers(user.userId, q ?? '');
  }

  @Get()
  @ApiOperation({ summary: 'List my friends with live presence' })
  list(@CurrentUser() user: any) {
    return this.friends.listFriendsWithPresence(user.userId);
  }

  @Get('requests')
  @ApiOperation({ summary: 'Pending friend requests (in/out)' })
  requests(@CurrentUser() user: any) {
    return this.friends.listPendingRequests(user.userId);
  }

  @Post('requests')
  @ApiOperation({ summary: 'Send a friend request' })
  send(@CurrentUser() user: any, @Body() dto: SendFriendRequestDto) {
    return this.friends.sendRequest(user.userId, dto.toUserId);
  }

  @Post('requests/:id/accept')
  @ApiOperation({ summary: 'Accept a pending friend request' })
  accept(@CurrentUser() user: any, @Param('id') id: string) {
    return this.friends.acceptRequest(user.userId, id);
  }

  @Post('requests/:id/reject')
  @ApiOperation({ summary: 'Reject a pending friend request' })
  reject(@CurrentUser() user: any, @Param('id') id: string) {
    return this.friends.rejectRequest(user.userId, id);
  }

  @Delete('requests/:id')
  @ApiOperation({ summary: 'Cancel a request you sent' })
  cancel(@CurrentUser() user: any, @Param('id') id: string) {
    return this.friends.cancelRequest(user.userId, id);
  }

  @Delete(':userId')
  @ApiOperation({ summary: 'Remove a friend' })
  unfriend(@CurrentUser() user: any, @Param('userId') otherUserId: string) {
    return this.friends.unfriend(user.userId, otherUserId);
  }
}
