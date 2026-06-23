import { PrismaClient, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import * as QRCode from 'qrcode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const prisma = new PrismaClient();

// QR Code signing (same secret as in .env)
const QR_SECRET = process.env.QR_SECRET || 'change-me-qr-secret-for-signing';

function generateQRToken(zoneId: string, seatId?: string): string {
  const payload = seatId ? `seat:${seatId}` : `zone:${zoneId}`;
  const signature = crypto
    .createHmac('sha256', QR_SECRET)
    .update(payload)
    .digest('hex')
    .substring(0, 16);
  return `${payload}:${signature}`;
}

async function generateQRCodeImage(token: string, filename: string): Promise<string> {
  const qrDir = path.join(__dirname, '../../admin/public/qr-exports');
  
  // Create directory if it doesn't exist
  if (!fs.existsSync(qrDir)) {
    fs.mkdirSync(qrDir, { recursive: true });
  }

  const filepath = path.join(qrDir, filename);
  await QRCode.toFile(filepath, token, {
    width: 300,
    margin: 2,
  });

  return `/qr-exports/${filename}`;
}

async function main() {
  console.log('🌱 Seeding database...');

  // Create admin user
  const adminHash = await bcrypt.hash('admin123', 10);
  await prisma.user.create({
    data: {
      email: 'admin@hku.hk',
      passwordHash: adminHash,
      role: UserRole.ADMIN,
    },
  });
  console.log('✓ Created admin user (admin@hku.hk / admin123)');

  // Create test student
  const studentHash = await bcrypt.hash('student123', 10);
  const student = await prisma.user.create({
    data: {
      email: 'student@connect.hku.hk',
      passwordHash: studentHash,
      role: UserRole.STUDENT,
    },
  });
  console.log('✓ Created test student (student@connect.hku.hk / student123)');

  // Create settings
  await prisma.setting.create({
    data: {
      key: 'checkinTimeoutMinutes',
      value: '60',
    },
  });
  console.log('✓ Created settings');

  // Create Chi Wah Learning Commons
  console.log('\n📚 Creating Chi Wah Learning Commons...');
  const chiWah = await prisma.building.create({
    data: {
      name: 'Chi Wah Learning Commons',
    },
  });

  const chiWahFloors = [];
  for (let i = 2; i <= 4; i++) {
    const floor = await prisma.floor.create({
      data: {
        buildingId: chiWah.id,
        index: i,
        name: `Level ${i}`,
      },
    });
    chiWahFloors.push(floor);
    console.log(`  ✓ Created Level ${i}`);

    // Create zones for each floor
    const zones = ['Zone A', 'Zone B', 'Zone C'];
    for (const zoneName of zones) {
      const capacity = Math.floor(Math.random() * 30) + 20; // 20-50 seats
      const qrCodeId = crypto.randomUUID();
      const token = generateQRToken(qrCodeId);
      const qrCodeUrl = await generateQRCodeImage(
        token,
        `chi-wah-l${i}-${zoneName.toLowerCase().replace(' ', '-')}.png`
      );

      await prisma.zone.create({
        data: {
          floorId: floor.id,
          name: zoneName,
          capacity,
          qrCodeId,
          qrCodeUrl,
        },
      });
      console.log(`    ✓ Created ${zoneName} (${capacity} seats)`);
    }
  }

  // Create Main Library
  console.log('\n📖 Creating Main Library...');
  const mainLib = await prisma.building.create({
    data: {
      name: 'Main Library',
    },
  });

  const mainLibFloors = [];
  for (let i = 1; i <= 4; i++) {
    const floorName = i === 1 ? 'Ground Floor' : `Level ${i}`;
    const floor = await prisma.floor.create({
      data: {
        buildingId: mainLib.id,
        index: i,
        name: floorName,
      },
    });
    mainLibFloors.push(floor);
    console.log(`  ✓ Created ${floorName}`);

    // Create zones for each floor
    const zonesCount = i === 1 ? 2 : 3; // Ground floor has fewer zones
    for (let j = 0; j < zonesCount; j++) {
      const zoneName = `Zone ${String.fromCharCode(65 + j)}`; // A, B, C, D
      const capacity = Math.floor(Math.random() * 40) + 30; // 30-70 seats
      const qrCodeId = crypto.randomUUID();
      const token = generateQRToken(qrCodeId);
      const qrCodeUrl = await generateQRCodeImage(
        token,
        `main-lib-l${i}-${zoneName.toLowerCase().replace(' ', '-')}.png`
      );

      await prisma.zone.create({
        data: {
          floorId: floor.id,
          name: zoneName,
          capacity,
          qrCodeId,
          qrCodeUrl,
        },
      });
      console.log(`    ✓ Created ${zoneName} (${capacity} seats)`);
    }
  }

  // Create some sample check-ins (for demo)
  const zones = await prisma.zone.findMany({ take: 3 });
  if (zones.length > 0) {
    await prisma.checkin.create({
      data: {
        userId: student.id,
        zoneId: zones[0].id,
        startedAt: new Date(Date.now() - 15 * 60 * 1000), // 15 minutes ago
      },
    });
    console.log('\n✓ Created sample check-in (active)');
  }

  console.log('\n🎉 Seed completed successfully!');
  console.log('\n📍 Summary:');
  console.log('  - 2 Buildings');
  console.log('  - 7 Floors');
  console.log('  - 21 Zones');
  console.log('  - QR codes generated in apps/admin/public/qr-exports/');
  console.log('\n🔐 Login credentials:');
  console.log('  Admin: admin@hku.hk / admin123');
  console.log('  Student: student@connect.hku.hk / student123');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
