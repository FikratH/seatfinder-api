import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as http2 from 'http2';
import * as jwt from 'jsonwebtoken';

/**
 * Lightweight APNs HTTP/2 client for Live Activity push updates.
 *
 * Why custom and not `@parse/node-apn`/`apn`?
 *   - We only need a single endpoint (`/3/device/<token>`) with the
 *     `liveactivity` push-type — totally different topic suffix and
 *     headers from a normal APNs alert. A 100-line client is cleaner
 *     than wrestling library defaults.
 *
 * Auth: APNs JWT (P8 .key file → ES256 token, refreshed every 50 min
 * since Apple rejects tokens older than 60 min).
 *
 * Required env vars (all optional — module silently no-ops if missing):
 *   APNS_KEY_ID                  Key identifier from Apple Developer portal
 *   APNS_TEAM_ID                 Apple Developer team ID
 *   APNS_BUNDLE_ID               Main app bundle (e.g. com.fikrat.hkuseat)
 *                                The widget topic suffix is appended automatically.
 *   APNS_KEY_PATH                Path to the .p8 file
 *     OR
 *   APNS_KEY_CONTENT             Inline P8 contents (for serverless/Docker)
 *   APNS_PRODUCTION              "true" → production gateway, else sandbox
 */
@Injectable()
export class ApnsClient {
  private readonly logger = new Logger(ApnsClient.name);
  private cachedJwt?: { token: string; issuedAt: number };
  private session?: http2.ClientHttp2Session;

  constructor(private readonly config: ConfigService) {}

  /** Whether APNs is configured. Other code should skip pushes if false. */
  isConfigured(): boolean {
    const keyId = this.config.get<string>('APNS_KEY_ID');
    const teamId = this.config.get<string>('APNS_TEAM_ID');
    const bundleId = this.config.get<string>('APNS_BUNDLE_ID');
    const keyPath = this.config.get<string>('APNS_KEY_PATH');
    const keyContent = this.config.get<string>('APNS_KEY_CONTENT');
    return Boolean(keyId && teamId && bundleId && (keyPath || keyContent));
  }

  private get host(): string {
    return this.config.get('APNS_PRODUCTION') === 'true'
      ? 'https://api.push.apple.com'
      : 'https://api.sandbox.push.apple.com';
  }

  private loadPrivateKey(): string | null {
    const inline = this.config.get<string>('APNS_KEY_CONTENT');
    if (inline) return inline;
    const path = this.config.get<string>('APNS_KEY_PATH');
    if (path && fs.existsSync(path)) {
      return fs.readFileSync(path, 'utf8');
    }
    return null;
  }

  private getJwt(): string | null {
    const now = Math.floor(Date.now() / 1000);
    if (this.cachedJwt && now - this.cachedJwt.issuedAt < 50 * 60) {
      return this.cachedJwt.token;
    }
    const keyId = this.config.get<string>('APNS_KEY_ID');
    const teamId = this.config.get<string>('APNS_TEAM_ID');
    const key = this.loadPrivateKey();
    if (!keyId || !teamId || !key) return null;

    const token = jwt.sign({ iss: teamId, iat: now }, key, {
      algorithm: 'ES256',
      header: { alg: 'ES256', kid: keyId },
    });
    this.cachedJwt = { token, issuedAt: now };
    return token;
  }

  private getSession(): http2.ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) {
      return this.session;
    }
    this.session = http2.connect(this.host);
    this.session.on('error', (err) => {
      this.logger.warn(`APNs session error: ${err.message}`);
    });
    this.session.on('close', () => {
      this.session = undefined;
    });
    return this.session;
  }

  /**
   * Push a Live Activity update. `event` is one of:
   *   - 'update' (default) — content state replaced.
   *   - 'end' — ends the activity with optional dismissal date.
   *
   * Returns true on apparent success (HTTP 200) and false otherwise; we never
   * throw because Live Activity pushes are best-effort UI sugar.
   */
  async pushLiveActivity(opts: {
    pushToken: string;
    contentState: Record<string, any>;
    event?: 'update' | 'end';
    /** When `event === 'end'`, seconds-since-epoch when iOS may dismiss. */
    dismissalDate?: number;
    /** Highest priority that won't get throttled. APNs caps liveactivity at 10/sec/device. */
    priority?: 5 | 10;
    /** Stale date — iOS will mark UI stale after this. */
    staleDate?: number;
    /** Activity attributes type (Swift struct name). */
    attributesType: string;
    /** Initial attributes (sent only on the first start push). */
    attributes?: Record<string, any>;
  }): Promise<boolean> {
    if (!this.isConfigured()) return false;
    const jwtToken = this.getJwt();
    if (!jwtToken) return false;

    const bundleId = this.config.get<string>('APNS_BUNDLE_ID')!;
    const topic = `${bundleId}.push-type.liveactivity`;

    const aps: Record<string, any> = {
      timestamp: Math.floor(Date.now() / 1000),
      event: opts.event ?? 'update',
      'content-state': opts.contentState,
      'attributes-type': opts.attributesType,
    };
    if (opts.attributes) aps.attributes = opts.attributes;
    if (opts.staleDate) aps['stale-date'] = opts.staleDate;
    if (opts.event === 'end' && opts.dismissalDate) {
      aps['dismissal-date'] = opts.dismissalDate;
    }

    const payload = JSON.stringify({ aps });

    return new Promise<boolean>((resolve) => {
      try {
        const session = this.getSession();
        const req = session.request({
          ':method': 'POST',
          ':path': `/3/device/${opts.pushToken}`,
          authorization: `bearer ${jwtToken}`,
          'apns-topic': topic,
          'apns-push-type': 'liveactivity',
          'apns-priority': String(opts.priority ?? 10),
          'apns-expiration': '0',
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
        });

        let status = 0;
        let body = '';
        req.on('response', (headers) => {
          status = Number(headers[':status']) || 0;
        });
        req.on('data', (chunk) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          if (status === 200) resolve(true);
          else {
            this.logger.warn(`APNs ${status}: ${body || '(no body)'}`);
            resolve(false);
          }
        });
        req.on('error', (err) => {
          this.logger.warn(`APNs request error: ${err.message}`);
          resolve(false);
        });

        req.setEncoding('utf8');
        req.write(payload);
        req.end();
      } catch (err) {
        this.logger.warn(`APNs push threw: ${(err as Error).message}`);
        resolve(false);
      }
    });
  }

  /** Tear down the connection on shutdown. */
  close(): void {
    if (this.session && !this.session.closed) {
      this.session.close();
    }
    this.session = undefined;
  }
}
