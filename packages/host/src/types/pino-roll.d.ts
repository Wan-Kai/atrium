declare module "pino-roll" {
  /** The SonicBoom stream pino-roll returns, reduced to what the host uses. */
  export interface RollStream {
    /** File descriptor; negative until the file is open. */
    readonly fd: number;
    write(chunk: string): boolean;
    end(): void;
    /** Set once the file is closed; writing then throws. */
    readonly destroyed: boolean;
    destroy(): void;
    once(event: "close" | "drain" | "ready", listener: () => void): this;
    once(event: "error", listener: (error: Error) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    off(event: "close" | "drain", listener: () => void): this;
    off(event: "error", listener: (error: Error) => void): this;
  }

  export interface PinoRollOptions {
    file: string;
    size?: string | number;
    limit?: { count: number; removeOtherLogFiles?: boolean };
    mkdir?: boolean;
    symlink?: boolean;
    /** File mode passed through to SonicBoom. */
    mode?: number;
  }

  export default function build(options: PinoRollOptions): Promise<RollStream>;
}
