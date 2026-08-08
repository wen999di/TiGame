type CanvasLike = HTMLCanvasElement | unknown;

const QRCode = {
  async toCanvas(_canvas: CanvasLike, _value: string, _options?: Record<string, unknown>) {
    return undefined;
  },
};

export default QRCode;
