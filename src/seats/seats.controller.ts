import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards, Res } from '@nestjs/common';
import { Response } from 'express';
import { SeatsService } from './seats.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';

@Controller('seats')
@UseGuards(JwtAuthGuard)
export class SeatsController {
  constructor(private readonly seatsService: SeatsService) {}

  @Get()
  findAll(@CurrentUser() user: any, @Query('zoneId') zoneId?: string) {
    const isAdmin = user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN';
    return this.seatsService.findAll(zoneId, isAdmin);
  }

  @Get(':id')
  findOne(@CurrentUser() user: any, @Param('id') id: string) {
    const isAdmin = user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN';
    return this.seatsService.findOne(id, isAdmin);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  create(@Body() data: { zoneId: string; label: string }) {
    return this.seatsService.create(data);
  }

  @Put(':id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  update(@Param('id') id: string, @Body() data: { label?: string; isActive?: boolean }) {
    return this.seatsService.update(id, data);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  delete(@Param('id') id: string) {
    return this.seatsService.delete(id);
  }

  @Get(':id/qr-token')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async generateQRToken(@Param('id') id: string) {
    const token = await this.seatsService.generateQRToken(id);
    return { token, seatId: id };
  }

  @Post('export-qr-pdf')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async exportQRCodesPDF(
    @Body() body: { seatIds?: string[] },
    @Res() res: Response,
  ) {
    const pdfBuffer = await this.seatsService.exportQRCodesPDF(body.seatIds);
    
    const filename = body.seatIds && body.seatIds.length > 0
      ? `seats-qr-codes-${body.seatIds.length}-items-${Date.now()}.pdf`
      : `all-seats-qr-codes-${Date.now()}.pdf`;

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': pdfBuffer.length,
    });

    res.send(pdfBuffer);
  }
}
