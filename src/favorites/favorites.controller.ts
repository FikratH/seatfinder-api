import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { FavoritesService } from './favorites.service';

class AddFavoriteDto {
  @IsString()
  zoneId: string;
}

@ApiTags('favorites')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('favorites')
export class FavoritesController {
  constructor(private readonly favorites: FavoritesService) {}

  @Get()
  @ApiOperation({ summary: 'List my favorite zones (with live occupancy)' })
  list(@CurrentUser() user: any) {
    return this.favorites.listForUser(user.userId);
  }

  @Post()
  @ApiOperation({ summary: 'Add a zone to favorites' })
  add(@CurrentUser() user: any, @Body() dto: AddFavoriteDto) {
    return this.favorites.add(user.userId, dto.zoneId);
  }

  @Delete(':zoneId')
  @ApiOperation({ summary: 'Remove a zone from favorites' })
  remove(@CurrentUser() user: any, @Param('zoneId') zoneId: string) {
    return this.favorites.remove(user.userId, zoneId);
  }

  @Get(':zoneId/exists')
  @ApiOperation({ summary: 'Check whether a zone is favorited' })
  exists(@CurrentUser() user: any, @Param('zoneId') zoneId: string) {
    return this.favorites.exists(user.userId, zoneId);
  }
}
