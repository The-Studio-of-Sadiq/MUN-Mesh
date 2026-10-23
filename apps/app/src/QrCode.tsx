import { useMemo } from 'react';
import Svg, { Path, Rect } from 'react-native-svg';
import qrcode from 'qrcode-generator';

const QUIET = 4;

/** Black-on-white QR drawn as one SVG path (fast even for dense codes). */
export function QrCode({ value, size }: { value: string; size: number }) {
  const { d, n } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    let path = '';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) if (qr.isDark(r, c)) path += `M${c} ${r}h1v1h-1z`;
    }
    return { d: path, n: count };
  }, [value]);
  const full = n + QUIET * 2;
  return (
    <Svg width={size} height={size} viewBox={`${-QUIET} ${-QUIET} ${full} ${full}`}>
      <Rect x={-QUIET} y={-QUIET} width={full} height={full} fill="#fff" />
      <Path d={d} fill="#000" />
    </Svg>
  );
}
