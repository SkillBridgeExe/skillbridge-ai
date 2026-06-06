import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bucket, Storage } from '@google-cloud/storage';
import { Readable } from 'stream';

export interface StorageUploadInput {
  key: string;
  body: Buffer;
  contentType: string;
}

export interface UploadedObject {
  bucket: string;
  key: string;
  etag: string | null;
}

export interface DownloadedFile {
  body: Readable;
  contentType: string | null;
  contentLength: number | null;
}

/**
 * Private object storage backed by Google Cloud Storage.
 *
 * Auth = Application Default Credentials: on Cloud Run this is the service
 * account attached to the service (NO access keys in env); locally it's the
 * gcloud ADC. The bucket is PRIVATE — CV/avatar bytes are streamed back through
 * the API (with JWT + ownership checks), never via public or signed URLs.
 *
 * Replaces the former Cloudflare R2 (S3) backend: same-region as Cloud Run
 * (free egress), no static credentials, and within the project's GCP budget.
 */
@Injectable()
export class GcsStorageService {
  private readonly logger = new Logger(GcsStorageService.name);
  private readonly bucket: Bucket;
  private readonly bucketName: string;

  constructor(private readonly config: ConfigService) {
    this.bucketName = this.requireConfig('GCS_BUCKET');
    const projectId = this.config.get<string>('GCS_PROJECT_ID') || undefined;
    const storage = new Storage(projectId ? { projectId } : {});
    this.bucket = storage.bucket(this.bucketName);
  }

  buildCvObjectKey(userId: string, cvId: string, originalName: string): string {
    const safeName = this.sanitize(originalName, 120);
    return `cvs/${userId}/${cvId}/${safeName || 'cv-file'}`;
  }

  buildAvatarObjectKey(userId: string, originalName: string): string {
    const safeName = this.sanitize(originalName, 160);
    return `avatars/${userId}/${safeName || 'avatar'}`;
  }

  async upload(input: StorageUploadInput): Promise<UploadedObject> {
    const file = this.bucket.file(input.key);
    await file.save(input.body, { contentType: input.contentType, resumable: false });
    this.logger.debug(`Uploaded GCS object bucket=${this.bucketName} key=${input.key}`);
    return {
      bucket: this.bucketName,
      key: input.key,
      etag: (file.metadata?.etag as string | undefined) ?? null,
    };
  }

  async download(key: string): Promise<DownloadedFile> {
    const file = this.bucket.file(key);
    let contentType: string | null = null;
    let contentLength: number | null = null;
    try {
      const [metadata] = await file.getMetadata();
      contentType = (metadata.contentType as string | undefined) ?? null;
      contentLength = metadata.size != null ? Number(metadata.size) : null;
    } catch {
      throw new InternalServerErrorException({
        errorCode: 'STORAGE_OBJECT_MISSING',
        message: 'Stored file not found',
      });
    }
    return { body: file.createReadStream(), contentType, contentLength };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.file(key).delete({ ignoreNotFound: true });
    this.logger.debug(`Deleted GCS object bucket=${this.bucketName} key=${key}`);
  }

  private sanitize(name: string, max: number): string {
    return name
      .trim()
      .replace(/[\\/]+/g, '-')
      .replace(/[^\w.\-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, max);
  }

  private requireConfig(key: string): string {
    const value = this.config.get<string>(key);
    if (!value) {
      throw new InternalServerErrorException({
        errorCode: 'CONFIGURATION_ERROR',
        message: `${key} is required for Google Cloud Storage`,
      });
    }
    return value;
  }
}
