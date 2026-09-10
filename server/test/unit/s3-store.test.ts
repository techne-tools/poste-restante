import { describe, it, expect, vi } from "vitest";
import { S3PayloadStore } from "../../src/minio/s3-store.js";
import { NoopPayloadStore } from "../../src/minio/store.js";
import type { S3Client } from "@aws-sdk/client-s3";

describe("S3PayloadStore", () => {
  it("puts and gets an object via S3Client", async () => {
    const mockSend = vi.fn().mockImplementation(async (command) => {
      const name = command.constructor.name;
      if (name === "PutObjectCommand") {
        return {};
      }
      if (name === "GetObjectCommand") {
        return {
          Body: {
            transformToByteArray: async () => new Uint8Array([1, 2, 3, 4]),
          },
        };
      }
      return {};
    });

    const mockClient = { send: mockSend } as unknown as S3Client;
    const store = new S3PayloadStore({
      endpoint: "http://localhost:9000",
      bucket: "test-bucket",
      client: mockClient,
    });

    const key = await store.put("let_123", "voice.wav", new Uint8Array([1, 2, 3, 4]), "audio/wav");
    expect(key).toBe("letters/let_123/voice.wav");

    const fetched = await store.get(key);
    expect(fetched).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("returns null when object does not exist", async () => {
    const mockSend = vi.fn().mockRejectedValue({ name: "NoSuchKey" });
    const mockClient = { send: mockSend } as unknown as S3Client;
    const store = new S3PayloadStore({
      endpoint: "http://localhost:9000",
      bucket: "test-bucket",
      client: mockClient,
    });

    const fetched = await store.get("letters/let_123/missing.bin");
    expect(fetched).toBeNull();
  });

  it("lists and deletes all payloads for a letter", async () => {
    const mockSend = vi.fn().mockImplementation(async (command) => {
      const name = command.constructor.name;
      if (name === "ListObjectsV2Command") {
        return {
          Contents: [
            { Key: "letters/let_abc/one.wav" },
            { Key: "letters/let_abc/two.wav" },
          ],
        };
      }
      if (name === "DeleteObjectsCommand" || name === "DeleteObjectCommand") {
        return {};
      }
      return {};
    });

    const mockClient = { send: mockSend } as unknown as S3Client;
    const store = new S3PayloadStore({
      endpoint: "http://localhost:9000",
      bucket: "test-bucket",
      client: mockClient,
    });

    const list = await store.listForLetter("let_abc");
    expect(list).toEqual(["letters/let_abc/one.wav", "letters/let_abc/two.wav"]);

    await store.deleteForLetter("let_abc");
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        constructor: expect.objectContaining({ name: "DeleteObjectsCommand" }),
      }),
    );
  });

  it("creates bucket on ensureBucket when NotFound", async () => {
    let checked = false;
    const mockSend = vi.fn().mockImplementation(async (command) => {
      const name = command.constructor.name;
      if (name === "HeadBucketCommand") {
        checked = true;
        const err = new Error("Bucket does not exist");
        (err as { name: string }).name = "NotFound";
        throw err;
      }
      if (name === "CreateBucketCommand") {
        return {};
      }
      return {};
    });

    const mockClient = { send: mockSend } as unknown as S3Client;
    const store = new S3PayloadStore({
      endpoint: "http://localhost:9000",
      bucket: "test-bucket",
      client: mockClient,
    });

    await store.ensureBucket();
    expect(checked).toBe(true);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        constructor: expect.objectContaining({ name: "CreateBucketCommand" }),
      }),
    );
  });
});

describe("NoopPayloadStore", () => {
  it("fails closed on put and returns null on get", async () => {
    const stub = new NoopPayloadStore();
    await expect(stub.put("let_1", "file.bin", new Uint8Array([1]))).rejects.toThrow("payload store is disabled");
    expect(await stub.get("letters/let_1/file.bin")).toBeNull();
    expect(await stub.listForLetter("let_1")).toEqual([]);
    await expect(stub.delete("letters/let_1/file.bin")).resolves.toBeUndefined();
    await expect(stub.deleteForLetter("let_1")).resolves.toBeUndefined();
  });
});
