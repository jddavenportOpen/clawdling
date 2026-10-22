export interface MockServer {
  url: string;
  port: number;
  readonly token: string;
  readonly link: string;
  close(): Promise<void>;
}

export interface MockOptions {
  port?: number;
  host?: string;
  token?: string;
  staticDir?: string;
  cors?: boolean;
  replyMs?: number;
  donnaMs?: number;
}

export function startMockServer(opts?: MockOptions): Promise<MockServer>;
