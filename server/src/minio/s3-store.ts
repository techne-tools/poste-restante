import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import type { PayloadStore } from "./store.js";

export interface S3PayloadStoreOptions {
  endpoint: string;
  bucket: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  client?: S3Client;
}

/**
 * MinIO / S3-compatible raw payload store.
 *
 * Implements the third tier of the archive spine:
 * Postgres (letters/envelope) + Qdrant (vectors) + MinIO (raw payloads: audio, images, files).
 *
 * Keys follow the convention: `letters/${letterId}/${name}`.
 */
export class S3PayloadStore implements PayloadStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: S3PayloadStoreOptions) {
    this.bucket = options.bucket;
    if (options.client) {
      this.client = options.client;
    } else {
      const config: S3ClientConfig = {
        endpoint: options.endpoint,
        region: options.region ?? "us-east-1",
        forcePathStyle: options.forcePathStyle ?? true,
      };
      if (options.accessKeyId && options.secretAccessKey) {
        config.credentials = {
          accessKeyId: options.accessKeyId,
          secretAccessKey: options.secretAccessKey,
        };
      }
      this.client = new S3Client(config);
    }
  }

  /**
   * Ensure the target bucket exists, creating it if absent.
   */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (err: unknown) {
      const name = (err as { name?: string })?.name;
      const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      if (name === "NotFound" || status === 404) {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      } else {
        throw err;
      }
    }
  }

  /**
   * Store a raw payload under `letters/${letterId}/${name}` and return its object key.
   */
  async put(
    letterId: string,
    name: string,
    data: Uint8Array,
    contentType?: string,
  ): Promise<string> {
    const key = `letters/${letterId}/${name}`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: contentType ?? "application/octet-stream",
      }),
    );
    return key;
  }

  /**
   * Fetch a raw payload by object key. Returns null if key does not exist.
   */
  async get(key: string): Promise<Uint8Array | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      if (!res.Body) return null;
      return await res.Body.transformToByteArray();
    } catch (err: unknown) {
      const name = (err as { name?: string })?.name;
      const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      if (name === "NoSuchKey" || name === "NotFound" || status === 404) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Delete a single raw payload by object key.
   */
  async delete(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
    } catch (err: unknown) {
      const name = (err as { name?: string })?.name;
      const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      if (name === "NoSuchKey" || name === "NotFound" || status === 404) {
        return;
      }
      throw err;
    }
  }

  /**
   * List all payload keys associated with a letter.
   */
  async listForLetter(letterId: string): Promise<string[]> {
    const prefix = `letters/${letterId}/`;
    try {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
        }),
      );
      if (!res.Contents) return [];
      return res.Contents.map((obj) => obj.Key).filter((k): k is string => Boolean(k));
    } catch {
      return [];
    }
  }

  /**
   * Delete all payloads associated with a letter (tier 3 cascade).
   */
  async deleteForLetter(letterId: string): Promise<void> {
    const keys = await this.listForLetter(letterId);
    if (keys.length === 0) return;

    try {
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: {
            Objects: keys.map((Key) => ({ Key })),
          },
        }),
      );
    } catch {
      // Fallback to individual deletes
      await Promise.all(keys.map((k) => this.delete(k)));
    }
  }
}
