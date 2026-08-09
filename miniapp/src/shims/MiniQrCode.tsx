import { useEffect } from "react";
import { Canvas } from "@tarojs/components";
import Taro from "@tarojs/taro";
import QRCode from "qrcode";

type MiniQrCodeProps = {
  value: string;
  className?: string;
};

const CANVAS_ID = "tigame-room-qr";

export function MiniQrCode({ value, className = "" }: MiniQrCodeProps) {
  useEffect(() => {
    if (!value) return;
    Taro.nextTick(() => {
      const query = Taro.createSelectorQuery() as any;
      query.select(`#${CANVAS_ID}`).fields({ node: true, size: true }).exec((result: any[]) => {
        const info = result?.[0];
        const canvas = info?.node;
        if (!canvas) return;
        const dpr = Math.max(1, Number(Taro.getWindowInfo?.().pixelRatio || 1));
        const width = Math.max(1, Math.round(Number(info.width || 168) * dpr));
        const height = Math.max(1, Math.round(Number(info.height || 168) * dpr));
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.fillStyle = "#f5ebdd";
        ctx.fillRect(0, 0, width, height);
        const matrix = QRCode.create(value, { errorCorrectionLevel: "M" }).modules;
        const quiet = 4;
        const total = matrix.size + quiet * 2;
        const cellW = width / total;
        const cellH = height / total;
        ctx.fillStyle = "#0b1726";
        for (let y = 0; y < matrix.size; y += 1) {
          for (let x = 0; x < matrix.size; x += 1) {
            if (!matrix.data[y * matrix.size + x]) continue;
            const left = Math.floor((x + quiet) * cellW);
            const top = Math.floor((y + quiet) * cellH);
            const right = Math.ceil((x + quiet + 1) * cellW);
            const bottom = Math.ceil((y + quiet + 1) * cellH);
            ctx.fillRect(left, top, right - left, bottom - top);
          }
        }
      });
    });
  }, [value]);

  return <Canvas id={CANVAS_ID} type="2d" className={className} />;
}
