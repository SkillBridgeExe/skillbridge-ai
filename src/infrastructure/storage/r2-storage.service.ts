import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';

export interface R2UploadInput {
  key: string;
  body: Buffer;
  contentType: string;
}

export interface R2UploadedObject {
  bucket: string;
  key: string;
  etag: string | null;
}

export interface R2DownloadedObject {
  body: Readable;
  contentType: string | null;
  contentLength: number | null;
}

@Injectable()
export class R2StorageService {
  private readonly logger = new Logger(R2StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: ConfigService) {
    const accountId = this.requireConfig('R2_ACCOUNT_ID');
    this.bucket = this.requireConfig('R2_BUCKET');
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: this.requireConfig('R2_ACCESS_KEY_ID'),
        secretAccessKey: this.requireConfig('R2_SECRET_ACCESS_KEY'),
      },
    });
  }

  buildCvObjectKey(userId: string, cvId: string, originalName: string): string {
    const safeName = originalName
      .trim()
      .replace(/[\\/]+/g, '-')
      .replace(/[^\w.\-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 120);
    return `cvs/${userId}/${cvId}/${safeName || 'cv-file'}`;
  }

  buildAvatarObjectKey(userId: string, _originalName: string): string {
    const safeName = _originalName
      .trim()
      .replace(/[\\/]+/g, '-')
      .replace(/[^\w.\-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 160);
    return `avatars/${userId}/${safeName || 'avatar'}`;
  }

  async upload(input: R2UploadInput): Promise<R2UploadedObject> {
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
      }),
    );
    this.logger.debug(`Uploaded R2 object bucket=${this.bucket} key=${input.key}`);
    return {
      bucket: this.bucket,
      key: input.key,
      etag: result.ETag ?? null,
    };
  }

  async download(key: string): Promise<R2DownloadedObject> {
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );

    if (!result.Body) {
      throw new InternalServerErrorException({
        errorCode: 'R2_OBJECT_EMPTY',
        message: 'Stored CV file is empty',
      });
    }

    return {
      body: this.toReadable(result.Body),
      contentType: result.ContentType ?? null,
      contentLength: result.ContentLength ?? null,
    };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
    this.logger.debug(`Deleted R2 object bucket=${this.bucket} key=${key}`);
  }

  private toReadable(body: unknown): Readable {
    if (body instanceof Readable) return body;
    if (body instanceof Uint8Array) return Readable.from(body);
    if (typeof body === 'string') return Readable.from(Buffer.from(body));
    throw new InternalServerErrorException({
      errorCode: 'R2_STREAM_UNSUPPORTED',
      message: 'Stored CV file stream is not supported by this runtime',
    });
  }

  private requireConfig(key: string): string {
    const value = this.config.get<string>(key);
    if (!value) {
      throw new InternalServerErrorException({
        errorCode: 'CONFIGURATION_ERROR',
        message: `${key} is required for Cloudflare R2 storage`,
      });
    }
    return value;
  }
}
