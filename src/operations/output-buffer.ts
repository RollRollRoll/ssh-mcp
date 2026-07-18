import { ErrorCodes } from "../errors/error-codes.js";

export const DEFAULT_OUTPUT_BUFFER_BYTES = 8_388_608;
export const DEFAULT_OUTPUT_READ_BYTES = 65_536;
export const MAX_OUTPUT_READ_BYTES = 262_144;

export type OutputStream = "stdout" | "stderr" | "pty";
export type OutputEncoding = "utf8" | "base64";

export interface OutputFrame {
  readonly stream: OutputStream;
  readonly cursor: number;
  readonly encoding: OutputEncoding;
  readonly data: string;
}

export interface OutputReadResult {
  readonly frames: readonly OutputFrame[];
  readonly nextCursor: number;
  readonly minCursor: number;
  readonly truncated: boolean;
  readonly droppedBytes: number;
}

export interface OutputBufferEntry extends OutputFrame {
  readonly metadata: unknown;
}

export interface OutputBufferEntryReadResult extends Omit<OutputReadResult, "frames"> {
  readonly frames: readonly OutputBufferEntry[];
}

export class OutputBufferError extends Error {
  public constructor(readonly code: typeof ErrorCodes.INVALID_CURSOR, message: string) {
    super(message);
    this.name = "OutputBufferError";
  }
}

interface StoredFrame {
  readonly stream: OutputStream;
  readonly cursor: number;
  readonly data: Buffer;
  readonly metadata: unknown;
}

export interface OutputAppendResult {
  readonly cursor: number;
  readonly byteLength: number;
}

/** 按接收顺序保存原始字节，游标永不因淘汰而重置。 */
export class OutputBuffer {
  private readonly frames: StoredFrame[] = [];
  private bytes = 0;
  private endCursor = 0;
  private minimumCursor = 0;
  private dropped = 0;

  public constructor(private readonly capacityBytes = DEFAULT_OUTPUT_BUFFER_BYTES) {
    if (!Number.isSafeInteger(capacityBytes) || capacityBytes <= 0) {
      throw new RangeError("输出缓冲容量必须是正安全整数");
    }
  }

  public append(stream: OutputStream, data: Buffer, metadata?: unknown): OutputAppendResult | undefined {
    if (stream !== "stdout" && stream !== "stderr" && stream !== "pty") {
      throw new RangeError("输出流必须是 stdout、stderr 或 pty");
    }
    if (data.length === 0) {
      return undefined;
    }
    if (!Number.isSafeInteger(this.endCursor + data.length)) {
      throw new RangeError("输出游标超出安全整数范围");
    }

    const copied = Buffer.from(data);
    const cursor = this.endCursor;
    this.frames.push({ stream, cursor, data: copied, metadata });
    this.endCursor += copied.length;
    this.bytes += copied.length;
    this.evictOverflow();
    return Object.freeze({ cursor, byteLength: copied.length });
  }

  public read(cursor = 0, maxBytes = DEFAULT_OUTPUT_READ_BYTES): OutputReadResult {
    const read = this.readEntries(cursor, maxBytes);
    return Object.freeze({
      ...read,
      frames: Object.freeze(read.frames.map(({ metadata: _metadata, ...frame }) => frame))
    });
  }

  /** 供需要绑定每帧内部元数据的调用方使用；MCP 输出仍由 read() 生成。 */
  public readEntries(cursor = 0, maxBytes = DEFAULT_OUTPUT_READ_BYTES): OutputBufferEntryReadResult {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.endCursor) {
      throw new OutputBufferError(ErrorCodes.INVALID_CURSOR, "输出游标无效");
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError("读取字节数必须是正安全整数");
    }

    const truncated = cursor < this.minimumCursor;
    let position = Math.max(cursor, this.minimumCursor);
    let remaining = maxBytes;
    const result: OutputBufferEntry[] = [];

    for (const frame of this.frames) {
      const frameEnd = frame.cursor + frame.data.length;
      if (frameEnd <= position || remaining === 0) {
        continue;
      }
      const offset = Math.max(0, position - frame.cursor);
      const available = frame.data.length - offset;
      const length = Math.min(available, remaining);
      const bytes = frame.data.subarray(offset, offset + length);
      result.push({
        stream: frame.stream,
        cursor: frame.cursor + offset,
        ...encode(bytes),
        metadata: frame.metadata
      });
      position += length;
      remaining -= length;
    }

    return Object.freeze({
      frames: Object.freeze(result),
      nextCursor: position,
      minCursor: this.minimumCursor,
      truncated,
      droppedBytes: this.dropped
    });
  }

  private evictOverflow(): void {
    while (this.bytes > this.capacityBytes) {
      const oldest = this.frames[0];
      if (oldest === undefined) {
        return;
      }
      const amount = Math.min(this.bytes - this.capacityBytes, oldest.data.length);
      this.bytes -= amount;
      this.dropped += amount;
      this.minimumCursor += amount;
      if (amount === oldest.data.length) {
        this.frames.shift();
      } else {
        this.frames[0] = {
          stream: oldest.stream,
          cursor: oldest.cursor + amount,
          data: oldest.data.subarray(amount),
          metadata: oldest.metadata
        };
      }
    }
  }
}

function encode(bytes: Buffer): Pick<OutputFrame, "encoding" | "data"> {
  try {
    return { encoding: "utf8", data: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { encoding: "base64", data: bytes.toString("base64") };
  }
}
