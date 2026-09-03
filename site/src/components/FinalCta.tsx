import { useEffect, useRef, useState } from "react";

const INSTALL = "npm i -g orchestra-board && orchestra init";

type Cloud = readonly [number, number, number];
const SKY = {
  seed: 7,
  far: [[.25, .3, .05], [.75, .6, .05]] as Cloud[],
  mid: [[.12, .55, .055], [.88, .25, .055]] as Cloud[],
  near: [[.94, .8, .05]] as Cloud[],
};

/** Static "digit sky" behind the closing CTA — a layered field of numerals drawn once per resize. */
function paintDigitSky(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  if (!context) return () => {};
  let seed = SKY.seed;
  const rand = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const build = () => {
    seed = SKY.seed;
    const box = canvas.parentElement!.getBoundingClientRect();
    canvas.width = box.width; canvas.height = box.height;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const layers = [
      { cell: 11, font: 7, alpha: [0.07, 0.14], ambient: 0.020, clouds: SKY.far },
      { cell: 16, font: 10, alpha: [0.16, 0.34], ambient: 0.030, clouds: SKY.mid },
      { cell: 22, font: 14, alpha: [0.34, 0.62], ambient: 0.012, clouds: SKY.near },
    ];
    for (const layer of layers) {
      const cols = Math.ceil(box.width / layer.cell), rows = Math.ceil(box.height / layer.cell);
      const clouds = layer.clouds.map((c) => ({ cx: c[0] * cols, cy: c[1] * rows, h: rows * c[2] }));
      const inCloud = (x: number, y: number) => {
        for (const { cx, cy, h } of clouds) {
          const w = h * 2.6;
          const lobes = [[cx, cy + h * .45, w, h * .75], [cx - w * .38, cy - h * .15, w * .48, h * .8], [cx + w * .3, cy - h * .35, w * .55, h * .95]];
          for (const [lx, ly, lw, lh] of lobes) {
            const dx = (x - lx) / lw, dy = (y - ly) / lh;
            if (dx * dx + dy * dy < 1) return true;
          }
        }
        return false;
      };
      context.font = `${layer.font}px "Geist Mono", monospace`;
      for (let x = 0; x < cols; x++) for (let y = 0; y < rows; y++) {
        const lit = inCloud(x, y);
        const roll = rand(), digit = String(Math.floor(rand() * 10));
        if (!lit && roll > layer.ambient) continue;
        const [lo, hi] = layer.alpha;
        context.fillStyle = lit ? `rgba(69,224,127,${lo + rand() * (hi - lo)})` : `rgba(233,235,242,${0.04 + rand() * 0.05})`;
        context.fillText(digit, x * layer.cell, y * layer.cell + layer.font);
      }
    }
    for (let i = 0; i < Math.round(box.width / 9); i++) {
      context.fillStyle = rand() > 0.75 ? "rgba(69,224,127,.8)" : "rgba(233,235,242,.55)";
      context.fillRect(rand() * box.width, rand() * box.height, rand() > 0.85 ? 2 : 1, 1);
    }
  };
  build();
  window.addEventListener("resize", build);
  return () => window.removeEventListener("resize", build);
}

export function FinalCta() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => (canvas.current ? paintDigitSky(canvas.current) : undefined), []);
  const copy = () => navigator.clipboard.writeText(INSTALL).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); });
  return (
    <div className="final" id="install">
      <canvas ref={canvas} className="digits" aria-hidden="true" />
      <div className="noise" aria-hidden="true" />
      <div className="final-inner">
        <img className="final-mark" src="assets/orchestra-mark-reversed.svg" alt="" width={106} height={66} aria-hidden="true" />
        <h2>Be the orchestra.</h2>
        <div className="cmd">
          <span><span className="p">$</span> {INSTALL}</span>
          <button type="button" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
        </div>
        <p className="alt">Free for you and your company · <a href="https://github.com/Armin2708/Orchestra/blob/main/LICENSE">FSL licensed</a> · macOS &amp; Linux</p>
      </div>
    </div>
  );
}
