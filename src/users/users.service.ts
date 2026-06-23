import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { User, UserRole, UserStatus } from '@prisma/client';

export interface PublicProfile {
  id: string;
  email: string;
  role: UserRole;
  displayName: string | null;
  avatarColor: string | null;
  bio: string | null;
}

/** Hex-color regex (#RGB / #RRGGBB). Allowed values are exactly six- or
 *  three-character hex strings prefixed with `#`. */
const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  async create(data: {
    email: string;
    passwordHash: string;
    role: UserRole;
  }): Promise<User> {
    return this.prisma.user.create({
      data: {
        email: data.email,
        passwordHash: data.passwordHash,
        role: data.role,
      },
    });
  }

  async updateStatus(id: string, status: UserStatus, banReason?: string, banExpiresAt?: Date): Promise<User> {
    return this.prisma.user.update({
      where: { id },
      data: {
        status,
        banReason,
        banExpiresAt,
      },
    });
  }

  /** Project a User row into the safe shape we expose to the client. */
  toPublic(u: User): PublicProfile {
    return {
      id: u.id,
      email: u.email,
      role: u.role,
      displayName: u.displayName,
      avatarColor: u.avatarColor,
      bio: u.bio,
    };
  }

  /**
   * Update the user's editable profile fields. All inputs are optional;
   * only fields actually provided are mutated. Validation enforces:
   *  - displayName: 1–40 chars (trimmed), printable
   *  - avatarColor: hex (#RGB or #RRGGBB) or `null` to reset
   *  - bio:         <= 280 chars (trimmed)
   */
  async updateProfile(
    userId: string,
    patch: { displayName?: string | null; avatarColor?: string | null; bio?: string | null },
  ): Promise<PublicProfile> {
    const data: { displayName?: string | null; avatarColor?: string | null; bio?: string | null } = {};

    if (patch.displayName !== undefined) {
      if (patch.displayName === null || patch.displayName === '') {
        data.displayName = null;
      } else {
        const trimmed = patch.displayName.trim();
        if (trimmed.length < 1 || trimmed.length > 40) {
          throw new BadRequestException('Display name must be between 1 and 40 characters.');
        }
        data.displayName = trimmed;
      }
    }

    if (patch.avatarColor !== undefined) {
      if (patch.avatarColor === null || patch.avatarColor === '') {
        data.avatarColor = null;
      } else if (!HEX_RE.test(patch.avatarColor)) {
        throw new BadRequestException('avatarColor must be a hex color like #0EA5E9.');
      } else {
        data.avatarColor = patch.avatarColor;
      }
    }

    if (patch.bio !== undefined) {
      if (patch.bio === null || patch.bio === '') {
        data.bio = null;
      } else {
        const trimmed = patch.bio.trim();
        if (trimmed.length > 280) {
          throw new BadRequestException('Bio must be 280 characters or fewer.');
        }
        data.bio = trimmed;
      }
    }

    const updated = await this.prisma.user.update({ where: { id: userId }, data });
    return this.toPublic(updated);
  }
}
