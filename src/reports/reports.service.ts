import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReportStatus, ReportType } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class ReportsService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  async create(userId: string, data: { zoneId: string; type: ReportType; message?: string }) {
    return this.prisma.report.create({
      data: {
        userId,
        zoneId: data.zoneId,
        type: data.type,
        message: data.message,
      },
    });
  }

  async findMyReports(userId: string) {
    return this.prisma.report.findMany({
      where: { userId },
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
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Admin: list all reports, optionally filtered by status.
   * Used by the admin moderation queue.
   */
  async findAllForAdmin(status?: ReportStatus) {
    return this.prisma.report.findMany({
      where: status ? { status } : undefined,
      include: {
        user: { select: { id: true, email: true } },
        zone: {
          include: {
            floor: { include: { building: true } },
          },
        },
        seat: { select: { id: true, label: true } },
        resolver: { select: { id: true, email: true } },
      },
      orderBy: [
        // PENDING first, then most recent
        { status: 'asc' },
        { createdAt: 'desc' },
      ],
    });
  }

  /**
   * Admin: resolve a report with an optional resolution note.
   */
  async resolve(reportId: string, adminId: string, resolution?: string) {
    const report = await this.prisma.report.findUnique({ where: { id: reportId } });
    if (!report) throw new NotFoundException('Report not found');

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.report.update({
        where: { id: reportId },
        data: {
          status: ReportStatus.RESOLVED,
          resolvedAt: new Date(),
          resolvedBy: adminId,
          resolution,
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: adminId,
          action: 'REPORT_RESOLVED',
          target: reportId,
          payload: resolution ? JSON.stringify({ resolution }) : null,
        },
      });

      return u;
    });

    // Fire push notification (best-effort, won't fail the request)
    void this.notifications
      .notifyReportResolved(report.userId, reportId, true, resolution ?? null)
      .catch(() => undefined);

    return updated;
  }

  /**
   * Admin: dismiss a report (no action required).
   */
  async dismiss(reportId: string, adminId: string, resolution?: string) {
    const report = await this.prisma.report.findUnique({ where: { id: reportId } });
    if (!report) throw new NotFoundException('Report not found');

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.report.update({
        where: { id: reportId },
        data: {
          status: ReportStatus.DISMISSED,
          resolvedAt: new Date(),
          resolvedBy: adminId,
          resolution,
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: adminId,
          action: 'REPORT_DISMISSED',
          target: reportId,
          payload: resolution ? JSON.stringify({ resolution }) : null,
        },
      });

      return u;
    });

    // Notify the original reporter (best-effort)
    void this.notifications
      .notifyReportResolved(report.userId, reportId, false, resolution ?? null)
      .catch(() => undefined);

    return updated;
  }
}
