// qrcode 的 core 只负责生成模块矩阵，不依赖浏览器 Canvas/DOM。
// @ts-expect-error qrcode 没有为内部 core 路径提供类型声明。
import QRCodeCore from "../../../node_modules/qrcode/lib/core/qrcode.js";

type CanvasLike = HTMLCanvasElement | unknown;

type CreatedQr = {
  modules: {
    size: number;
    data: Uint8Array | boolean[];
  };
};

function encodeUtf8(value: string) {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
        index += 1;
      } else {
        codePoint = 0xfffd;
      }
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      codePoint = 0xfffd;
    }

    if (codePoint <= 0x7f) bytes.push(codePoint);
    else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

const QRCode = {
  create(value: string, options?: Record<string, unknown>): CreatedQr {
    // qrcode@1.5.4 的 ByteData 对字符串会调用浏览器 TextEncoder，
    // 微信小程序 JSCore 并不保证提供它。预先编码为 Uint8Array 并显式使用
    // byte 模式，可完全绕过该浏览器 API，同时保留标准 UTF-8 内容。
    const byteSegment = { data: encodeUtf8(value), mode: "byte" };
    return QRCodeCore.create([byteSegment], options) as CreatedQr;
  },
  async toCanvas(_canvas: CanvasLike, _value: string, _options?: Record<string, unknown>) {
    return undefined;
  },
};

export default QRCode;
