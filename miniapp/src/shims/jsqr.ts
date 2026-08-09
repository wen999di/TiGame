export type MiniQrResult = { data: string };

export default function jsQR(
  _data: Uint8ClampedArray | Uint8Array,
  _width: number,
  _height: number,
  _options?: { inversionAttempts?: string },
): MiniQrResult | null {
  return null;
}
