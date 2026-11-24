declare module 'cloudflare:sockets' {
  export interface SocketAddress {
    hostname: string;
    port: number;
  }
  export interface SocketOptions {
    secureTransport?: 'off' | 'on' | 'starttls';
    allowHalfOpen?: boolean;
  }
  export interface Socket {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    opened: Promise<unknown>;
    closed: Promise<void>;
    close(): Promise<void>;
    startTls(): Socket;
  }
  export function connect(address: SocketAddress, options?: SocketOptions): Socket;
}
