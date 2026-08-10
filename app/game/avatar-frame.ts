export const MAX_AVATAR_BYTES = 64 * 1024;

export type AvatarMime = "image/jpeg" | "image/png" | "image/webp";

const FRAME_UPLOAD = 0xa1;
const FRAME_DELIVERY = 0xa2;

const MIME_CODE: Record<AvatarMime, number> = {
  "image/jpeg": 1,
  "image/png": 2,
  "image/webp": 3,
};

function mimeFromCode(code: number): AvatarMime | null {
  if (code === 1) return "image/jpeg";
  if (code === 2) return "image/png";
  if (code === 3) return "image/webp";
  return null;
}

export function detectAvatarMime(image: ArrayBuffer | Uint8Array): AvatarMime | null {
  const bytes = image instanceof Uint8Array ? image : new Uint8Array(image);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_AVATAR_BYTES) return null;
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.byteLength >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.byteLength >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function validImageBytes(mime: AvatarMime, bytes: Uint8Array): boolean {
  return detectAvatarMime(bytes) === mime;
}

function asciiBytes(value: string): Uint8Array | null {
  if (!value || value.length > 96) return null;
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return null;
    bytes[index] = code;
  }
  return bytes;
}

function asciiString(bytes: Uint8Array): string {
  let value = "";
  for (let index = 0; index < bytes.length; index += 1) value += String.fromCharCode(bytes[index]);
  return value;
}

export function encodeAvatarUploadFrame(mime: AvatarMime, image: ArrayBuffer): ArrayBuffer | null {
  const bytes = new Uint8Array(image);
  if (!validImageBytes(mime, bytes)) return null;
  const frame = new Uint8Array(2 + bytes.byteLength);
  frame[0] = FRAME_UPLOAD;
  frame[1] = MIME_CODE[mime];
  frame.set(bytes, 2);
  return frame.buffer;
}

export function decodeAvatarUploadFrame(frame: ArrayBuffer): { mime: AvatarMime; bytes: ArrayBuffer } | null {
  const raw = new Uint8Array(frame);
  if (raw.byteLength < 3 || raw[0] !== FRAME_UPLOAD) return null;
  const mime = mimeFromCode(raw[1]);
  if (!mime) return null;
  const bytes = raw.slice(2);
  if (!validImageBytes(mime, bytes)) return null;
  return { mime, bytes: bytes.buffer };
}

export function encodeAvatarDeliveryFrame(playerId: string, mime: AvatarMime, image: ArrayBuffer): ArrayBuffer | null {
  const id = asciiBytes(playerId);
  const bytes = new Uint8Array(image);
  if (!id || id.byteLength > 255 || !validImageBytes(mime, bytes)) return null;
  const frame = new Uint8Array(3 + id.byteLength + bytes.byteLength);
  frame[0] = FRAME_DELIVERY;
  frame[1] = MIME_CODE[mime];
  frame[2] = id.byteLength;
  frame.set(id, 3);
  frame.set(bytes, 3 + id.byteLength);
  return frame.buffer;
}

export function decodeAvatarDeliveryFrame(frame: ArrayBuffer): { playerId: string; mime: AvatarMime; bytes: ArrayBuffer } | null {
  const raw = new Uint8Array(frame);
  if (raw.byteLength < 5 || raw[0] !== FRAME_DELIVERY) return null;
  const mime = mimeFromCode(raw[1]);
  const idLength = raw[2];
  const imageOffset = 3 + idLength;
  if (!mime || idLength === 0 || imageOffset >= raw.byteLength) return null;
  const playerId = asciiString(raw.slice(3, imageOffset));
  if (!asciiBytes(playerId)) return null;
  const bytes = raw.slice(imageOffset);
  if (!validImageBytes(mime, bytes)) return null;
  return { playerId, mime, bytes: bytes.buffer };
}
