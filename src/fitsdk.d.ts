declare module "@garmin/fitsdk" {
  export const Stream: {
    fromByteArray(bytes: Uint8Array): unknown;
  };
  export class Decoder {
    constructor(stream: unknown);
    isFIT(): boolean;
    read(opts?: Record<string, unknown>): {
      messages: Record<string, Record<string, unknown>[]>;
      errors: unknown[];
    };
  }
}
