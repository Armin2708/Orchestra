"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";

/**
 * Topographic contour lines for the hero background.
 *
 * A height field made of a few gaussian "hills" plus gentle ripple is sampled on a grid;
 * marching squares extracts isolines at N elevations; segments are chained into
 * polylines and smoothed (Catmull-Rom → cubic Béziers). Every 4th level is an index
 * contour (heavier), like a real topo map. Each contour animates with the same
 * framer-motion flow as the Background Paths component (pathLength / pathOffset /
 * opacity, mirrored so nothing snaps).
 */
const W = 1440, H = 900, CELL = 18, LEVELS = 20;

type Hill = { cx: number; cy: number; sx: number; sy: number; a: number };
const HILLS: Hill[] = [
    { cx: 330, cy: 660, sx: 330, sy: 240, a: 1.0 },
    { cx: 1130, cy: 280, sx: 310, sy: 220, a: 0.88 },
    { cx: 930, cy: 840, sx: 280, sy: 170, a: 0.62 },
    { cx: 680, cy: 90, sx: 460, sy: 150, a: 0.42 },
];

function height(x: number, y: number) {
    let h = 0;
    for (const { cx, cy, sx, sy, a } of HILLS) {
        const dx = (x - cx) / sx, dy = (y - cy) / sy;
        h += a * Math.exp(-(dx * dx + dy * dy) / 2);
    }
    // gentle ripple so rings are not perfectly smooth ellipses
    h += 0.045 * Math.sin(x / 150 + 1.3) * Math.cos(y / 115 - 0.7) + 0.03 * Math.sin((x + y) / 95);
    return h;
}

type Pt = [number, number];
const key = (p: Pt) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;

/** Marching squares for one level → list of polylines (closed when possible). */
function isolines(level: number): Pt[][] {
    const cols = Math.ceil(W / CELL), rows = Math.ceil(H / CELL);
    const grid: number[][] = [];
    for (let j = 0; j <= rows; j++) {
        grid.push([]);
        for (let i = 0; i <= cols; i++) grid[j].push(height(i * CELL, j * CELL));
    }
    const lerp = (x0: number, y0: number, v0: number, x1: number, y1: number, v1: number): Pt => {
        const t = (level - v0) / (v1 - v0 || 1e-9);
        return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
    };
    const segs: [Pt, Pt][] = [];
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const x0 = i * CELL, y0 = j * CELL, x1 = x0 + CELL, y1 = y0 + CELL;
        const tl = grid[j][i], tr = grid[j][i + 1], br = grid[j + 1][i + 1], bl = grid[j + 1][i];
        const idx = (tl > level ? 8 : 0) | (tr > level ? 4 : 0) | (br > level ? 2 : 0) | (bl > level ? 1 : 0);
        if (idx === 0 || idx === 15) continue;
        const top = () => lerp(x0, y0, tl, x1, y0, tr), right = () => lerp(x1, y0, tr, x1, y1, br);
        const bottom = () => lerp(x0, y1, bl, x1, y1, br), left = () => lerp(x0, y0, tl, x0, y1, bl);
        switch (idx) {
            case 1: case 14: segs.push([left(), bottom()]); break;
            case 2: case 13: segs.push([bottom(), right()]); break;
            case 3: case 12: segs.push([left(), right()]); break;
            case 4: case 11: segs.push([top(), right()]); break;
            case 5: segs.push([left(), top()], [bottom(), right()]); break;
            case 6: case 9: segs.push([top(), bottom()]); break;
            case 7: case 8: segs.push([left(), top()]); break;
            case 10: segs.push([left(), bottom()], [top(), right()]); break;
        }
    }
    // chain segments into polylines by matching endpoints
    const byEnd = new Map<string, number[]>();
    segs.forEach((s, n) => { for (const p of s) { const k = key(p); (byEnd.get(k) ?? byEnd.set(k, []).get(k)!).push(n); } });
    const used = new Array(segs.length).fill(false);
    const lines: Pt[][] = [];
    for (let n = 0; n < segs.length; n++) {
        if (used[n]) continue;
        used[n] = true;
        const line: Pt[] = [segs[n][0], segs[n][1]];
        for (const dir of [1, -1] as const) {
            for (;;) {
                const end = dir === 1 ? line[line.length - 1] : line[0];
                const next = (byEnd.get(key(end)) ?? []).find((m) => !used[m]);
                if (next === undefined) break;
                used[next] = true;
                const [a, b] = segs[next];
                const p = key(a) === key(end) ? b : a;
                dir === 1 ? line.push(p) : line.unshift(p);
            }
        }
        if (line.length >= 6) lines.push(line);
    }
    return lines;
}

/** Catmull-Rom spline through the points → SVG path with cubic Béziers. */
function smoothPath(pts: Pt[]): string {
    const closed = key(pts[0]) === key(pts[pts.length - 1]);
    const p = closed ? pts.slice(0, -1) : pts;
    const n = p.length;
    const at = (i: number) => (closed ? p[(i + n) % n] : p[Math.max(0, Math.min(n - 1, i))]);
    let d = `M${p[0][0].toFixed(1)} ${p[0][1].toFixed(1)}`;
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
        const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
        const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
        const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
        d += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)}, ${c2[0].toFixed(1)} ${c2[1].toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
    }
    return closed ? d + " Z" : d;
}

function buildContours() {
    const out: { id: number; d: string; index: boolean; t: number }[] = [];
    let id = 0;
    for (let l = 0; l < LEVELS; l++) {
        const t = (l + 1) / (LEVELS + 1);            // 0..1 elevation
        const level = 0.06 + t * 0.92;
        for (const line of isolines(level)) out.push({ id: id++, d: smoothPath(line), index: l % 4 === 3, t });
    }
    return out;
}

export function ContourPaths() {
    const contours = useMemo(buildContours, []);
    return (
        <div className="absolute inset-0 pointer-events-none">
            <svg
                className="w-full h-full text-slate-950 dark:text-white"
                viewBox={`0 0 ${W} ${H}`}
                preserveAspectRatio="xMidYMid slice"
                fill="none"
            >
                <title>Topographic contours</title>
                {contours.map((c) => (
                    <motion.path
                        key={c.id}
                        d={c.d}
                        stroke="currentColor"
                        strokeWidth={c.index ? 1.3 : 0.7}
                        strokeOpacity={(c.index ? 0.8 : 0.48) * (0.55 + c.t * 0.45)}
                        strokeLinejoin="round"
                        initial={{ pathLength: 0.3, opacity: 0.6 }}
                        animate={{
                            pathLength: 1,
                            opacity: [0.3, 0.6, 0.3],
                            pathOffset: [0, 1, 0],
                        }}
                        transition={{
                            duration: 20 + Math.random() * 10,
                            repeat: Number.POSITIVE_INFINITY,
                            repeatType: "mirror",
                            ease: "linear",
                        }}
                    />
                ))}
            </svg>
        </div>
    );
}
