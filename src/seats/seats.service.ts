import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { createHash, randomBytes } from 'crypto';
import * as QRCode from 'qrcode';
import PDFDocument from 'pdfkit';

@Injectable()
export class SeatsService {
  constructor(private prisma: PrismaService) {}

  async findAll(zoneId?: string, viewerIsAdmin = false) {
    const seats = await this.prisma.seat.findMany({
      where: zoneId ? { zoneId } : {},
      include: {
        zone: {
          include: {
            floor: {
              include: {
                building: true,
              },
            },
          },
        },
        checkins: {
          where: {
            endedAt: null,
          },
          take: 1,
          include: {
            user: {
              select: {
                id: true,
                email: true,
              },
            },
          },
        },
      },
      orderBy: { label: 'asc' },
    });

    return seats.map((seat) => ({
      ...seat,
      checkins: seat.checkins.map((c) => ({
        id: c.id,
        startedAt: c.startedAt,
        // PII redacted for non-admin viewers (privacy / PDPO)
        ...(viewerIsAdmin ? { user: c.user, userId: c.userId } : {}),
      })),
    }));
  }

  async findOne(id: string, viewerIsAdmin = false) {
    const seat = await this.prisma.seat.findUnique({
      where: { id },
      include: {
        zone: {
          include: {
            floor: {
              include: {
                building: true,
              },
            },
          },
        },
        checkins: {
          where: {
            endedAt: null,
          },
          include: {
            user: {
              select: {
                id: true,
                email: true,
              },
            },
          },
        },
      },
    });

    if (!seat) return null;

    return {
      ...seat,
      checkins: seat.checkins.map((c) => ({
        id: c.id,
        startedAt: c.startedAt,
        // PII redacted for non-admin viewers (privacy / PDPO)
        ...(viewerIsAdmin ? { user: c.user, userId: c.userId } : {}),
      })),
    };
  }

  async create(data: { zoneId: string; label: string }) {
    // Generate unique QR code ID
    const qrCodeId = `SEAT-${randomBytes(8).toString('hex').toUpperCase()}`;

    return this.prisma.seat.create({
      data: {
        ...data,
        qrCodeId,
        isActive: true,
      },
      include: {
        zone: {
          include: {
            floor: {
              include: {
                building: true,
              },
            },
          },
        },
      },
    });
  }

  async update(id: string, data: { label?: string; isActive?: boolean }) {
    return this.prisma.seat.update({
      where: { id },
      data,
      include: {
        zone: true,
      },
    });
  }

  async delete(id: string) {
    return this.prisma.seat.delete({
      where: { id },
    });
  }

  async generateQRToken(seatId: string): Promise<string> {
    const seat = await this.prisma.seat.findUnique({
      where: { id: seatId },
      select: { qrCodeId: true },
    });

    if (!seat) {
      throw new Error('Seat not found');
    }

    // Generate HMAC signed token (same as zones)
    const secret = process.env.QR_SECRET || 'change-me-in-production';
    const timestamp = Date.now();
    const payload = `${seat.qrCodeId}:${timestamp}`;
    const signature = createHash('sha256')
      .update(`${payload}:${secret}`)
      .digest('hex');

    return `${payload}:${signature}`;
  }

  async exportQRCodesPDF(seatIds?: string[]): Promise<Buffer> {
    // Fetch seats to export
    const seats = await this.prisma.seat.findMany({
      where: seatIds ? { id: { in: seatIds } } : {},
      include: {
        zone: {
          include: {
            floor: {
              include: {
                building: true,
              },
            },
          },
        },
      },
      orderBy: [
        { zone: { floor: { building: { name: 'asc' } } } },
        { zone: { floor: { index: 'asc' } } },
        { zone: { name: 'asc' } },
        { label: 'asc' },
      ],
    });

    if (seats.length === 0) {
      throw new Error('No seats found to export');
    }

    // Create PDF document
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      info: {
        Title: 'HKU Seat Finder - QR Codes',
        Author: 'HKU Seat Finder System',
      },
    });

    // Convert to buffer
    const buffers: Buffer[] = [];
    doc.on('data', buffers.push.bind(buffers));

    // Title page
    doc
      .fontSize(24)
      .font('Helvetica-Bold')
      .text('HKU Seat Finder', { align: 'center' })
      .moveDown(0.5)
      .fontSize(18)
      .font('Helvetica')
      .text('Seat QR Codes', { align: 'center' })
      .moveDown(0.5)
      .fontSize(10)
      .text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' })
      .text(`Total Seats: ${seats.length}`, { align: 'center' })
      .moveDown(2);

    // Instructions
    doc
      .fontSize(12)
      .font('Helvetica-Bold')
      .text('Instructions:', { align: 'left' })
      .moveDown(0.3)
      .fontSize(10)
      .font('Helvetica')
      .text('1. Print these pages on adhesive paper or regular paper', { align: 'left' })
      .text('2. Cut out each QR code along the dotted lines', { align: 'left' })
      .text('3. Attach to the corresponding seat', { align: 'left' })
      .text('4. Ensure QR codes are visible and not damaged', { align: 'left' })
      .moveDown(2);

    doc.addPage();

    // Layout configuration
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const pageHeight = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
    const qrSize = 150; // QR code size
    const cardWidth = 200;
    const cardHeight = 240;
    const cols = 2;
    const rows = 3;
    const spacingX = (pageWidth - (cols * cardWidth)) / (cols + 1);
    const spacingY = (pageHeight - (rows * cardHeight)) / (rows + 1);

    let currentRow = 0;
    let currentCol = 0;

    for (const seat of seats) {
      // Check if we need a new page
      if (currentRow >= rows) {
        doc.addPage();
        currentRow = 0;
        currentCol = 0;
      }

      // Calculate position
      const x = doc.page.margins.left + spacingX + (currentCol * (cardWidth + spacingX));
      const y = doc.page.margins.top + spacingY + (currentRow * (cardHeight + spacingY));

      // Generate QR code token
      const qrToken = await this.generateQRToken(seat.id);

      // Generate QR code as data URL
      const qrDataURL = await QRCode.toDataURL(qrToken, {
        width: qrSize,
        margin: 1,
        errorCorrectionLevel: 'H',
      });

      // Draw card border (dotted line for cutting)
      doc
        .save()
        .dash(5, { space: 3 })
        .strokeColor('#cccccc')
        .rect(x, y, cardWidth, cardHeight)
        .stroke()
        .restore();

      // Draw QR code
      const qrX = x + (cardWidth - qrSize) / 2;
      const qrY = y + 20;
      doc.image(qrDataURL, qrX, qrY, {
        width: qrSize,
        height: qrSize,
      });

      // Seat information
      const textY = qrY + qrSize + 15;
      doc
        .fontSize(14)
        .font('Helvetica-Bold')
        .text(`Seat ${seat.label}`, x, textY, {
          width: cardWidth,
          align: 'center',
        })
        .moveDown(0.3);

      doc
        .fontSize(9)
        .font('Helvetica')
        .text(seat.zone.name, x, doc.y, {
          width: cardWidth,
          align: 'center',
        })
        .text(
          `${seat.zone.floor.building.name} - ${seat.zone.floor.name || `Floor ${seat.zone.floor.index}`}`,
          x,
          doc.y,
          {
            width: cardWidth,
            align: 'center',
          }
        );

      // Move to next position
      currentCol++;
      if (currentCol >= cols) {
        currentCol = 0;
        currentRow++;
      }
    }

    // Finalize PDF
    doc.end();

    // Return buffer
    return new Promise((resolve, reject) => {
      doc.on('end', () => {
        resolve(Buffer.concat(buffers));
      });
      doc.on('error', reject);
    });
  }
}
