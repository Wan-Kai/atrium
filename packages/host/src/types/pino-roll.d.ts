declare module "pino-roll" {
  /** The SonicBoom stream pino-roll returns, reduced to what the host uses. */
  export interface RollStream {
    /** File descriptor; negative until the file is open. */
    readonly fd: number;
    write(chunk: string): boolean;
    flushSync(): void;
    end(): void;
    once(event: "close" | "ready", listener: () => void): this;
  }

  export interface PinoRollOptions {
    file: string;
    size?: string | number;
    limit?: { count: number };
    mkdir?: boolean;
    symlink?: boolean;
    /** File mode passed through to SonicBoom. */
    mode?: number;
  }

  export default function build(options: PinoRollOptions): Promise<RollStream>;
}
