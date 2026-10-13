export type Rgb = [number, number, number];
export function parseOklch(s: string): { l: number; c: number; h: number; a: number } {
  const m = s.match(/oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)/);
  if (!m) throw new Error("not oklch: " + s);
  return { l: Number(m[1]) / 100, c: Number(m[2]), h: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) };
}
export function oklchToLinearSrgb(s: string): Rgb {
  const { l, c, h } = parseOklch(s);
  const a = c * Math.cos((h * Math.PI) / 180), b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clip = (x: number) => Math.min(1, Math.max(0, x));
  return [
    clip(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    clip(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    clip(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  ];
}
export function luminance(rgb: Rgb): number { return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]; }
export function contrast(fg: string, bg: string): number {
  const [x, y] = [luminance(oklchToLinearSrgb(fg)), luminance(oklchToLinearSrgb(bg))].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
