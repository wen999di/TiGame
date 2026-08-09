import { useMemo } from "react";
import { View } from "@tarojs/components";
import QRCode from "qrcode";

type MiniQrCodeProps = {
  value: string;
  className?: string;
};

type ModuleRun = {
  key: string;
  left: string;
  top: string;
  width: string;
  height: string;
};

const QUIET_ZONE = 0;

function buildModuleRuns(value: string): ModuleRun[] {
  if (!value) return [];
  const matrix = QRCode.create(value, { errorCorrectionLevel: "M" }).modules;
  const total = matrix.size + QUIET_ZONE * 2;
  const unit = 100 / total;
  const runs: ModuleRun[] = [];

  for (let y = 0; y < matrix.size; y += 1) {
    let start = -1;
    for (let x = 0; x <= matrix.size; x += 1) {
      const dark = x < matrix.size && Boolean(matrix.data[y * matrix.size + x]);
      if (dark && start < 0) start = x;
      if (dark || start < 0) continue;
      runs.push({
        key: `${y}-${start}`,
        left: `${(start + QUIET_ZONE) * unit}%`,
        top: `${(y + QUIET_ZONE) * unit}%`,
        width: `${(x - start) * unit}%`,
        height: `${unit}%`,
      });
      start = -1;
    }
  }
  return runs;
}

export function MiniQrCode({ value, className = "" }: MiniQrCodeProps) {
  const runs = useMemo(() => buildModuleRuns(value), [value]);
  return (
    <View
      className={className}
      style={{ position: "relative", overflow: "hidden", backgroundColor: "#f5ebdd" }}
      aria-label="房间邀请二维码"
    >
      {runs.map((run) => (
        <View
          key={run.key}
          style={{
            position: "absolute",
            left: run.left,
            top: run.top,
            width: run.width,
            height: run.height,
            backgroundColor: "#0b1726",
          }}
        />
      ))}
    </View>
  );
}
