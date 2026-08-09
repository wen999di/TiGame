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

const QRCode = {
  create(value: string, options?: Record<string, unknown>): CreatedQr {
    return QRCodeCore.create(value, options) as CreatedQr;
  },
  async toCanvas(_canvas: CanvasLike, _value: string, _options?: Record<string, unknown>) {
    return undefined;
  },
};

export default QRCode;
