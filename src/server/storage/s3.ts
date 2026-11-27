/**
 * Private object storage (ADR-9). S3 API: MinIO in dev, any S3-compatible store in prod.
 * Objects are never public; downloads go through /api/files/[id] → 5-minute presigned GET.
 *
 * Fake (tests / no S3 keys outside prod): files under $TMPDIR/lavigo-storage.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../env";

export const PRESIGN_SECONDS = 300;

export interface ObjectStorage {
  readonly mode: "real" | "fake";
  put(key: string, body: Buffer | Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  presignGet(key: string, opts?: { fileName?: string; expiresIn?: number }): Promise<string>;
}

function client(endpoint: string): S3Client {
  return new S3Client({
    endpoint,
    region: env.S3_REGION,
    forcePathStyle: true, // MinIO
    credentials: { accessKeyId: env.S3_ACCESS_KEY!, secretAccessKey: env.S3_SECRET_KEY! },
  });
}

class S3Storage implements ObjectStorage {
  readonly mode = "real" as const;
  private readonly internal = client(env.S3_ENDPOINT!);
  // Presigned URLs embed the host in the signature, so sign with the host the browser will use.
  private readonly publicClient = client(env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT!);

  async put(key: string, body: Buffer | Uint8Array, contentType: string) {
    await this.internal.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: body, ContentType: contentType }));
  }

  async get(key: string) {
    const res = await this.internal.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }

  async presignGet(key: string, opts: { fileName?: string; expiresIn?: number } = {}) {
    const disposition = opts.fileName ? `attachment; filename="${opts.fileName.replace(/[^\w.\- ]/g, "_")}"` : undefined;
    return getSignedUrl(
      this.publicClient,
      new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key, ResponseContentDisposition: disposition }),
      { expiresIn: opts.expiresIn ?? PRESIGN_SECONDS },
    );
  }
}

class FakeStorage implements ObjectStorage {
  readonly mode = "fake" as const;
  private readonly root = env.FAKE_STORAGE_DIR ? path.resolve(env.FAKE_STORAGE_DIR) : path.join(tmpdir(), "lavigo-storage");
  private file(key: string) {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep)) throw new Error("invalid key");
    return p;
  }
  async put(key: string, body: Buffer | Uint8Array) {
    await mkdir(path.dirname(this.file(key)), { recursive: true });
    await writeFile(this.file(key), body);
  }
  async get(key: string) {
    return readFile(this.file(key));
  }
  async presignGet(key: string) {
    return `file://${this.file(key)}`;
  }
}

let storage: ObjectStorage | undefined;

export function getStorage(): ObjectStorage {
  storage ??= env.providers.storage === "real" ? new S3Storage() : new FakeStorage();
  return storage;
}
