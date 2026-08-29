# ImageGen broken-arch prototype

Generated with the built-in `$imagegen` workflow from the operator's sketch.
This is a raster concept study, not a production identity asset.

## Final prompt

Use the supplied sketch as a structural reference for a precise, flat,
vector-friendly Orchestra logo: three concentric semicircular rows, exactly
three separate curved blocks per row, blocks growing wider and heavier from
outer to inner, and one centered square-corner horizontal podium. Preserve
bilateral symmetry and generous square safe margins. Use `#A1A19B` for the
outer row, `#62625D` for the middle row, `#111111` for the inner row and
podium, and `#F7F6F3` for the background. No text, instruments, people,
notes, circles, nodes, extra blocks, outlines, 3D, texture, or watermark.

`orchestra-broken-arches-v1.png` is the refined generation selected for
initial review. `orchestra-broken-arches-v2-equal-sections.png` refines every
row to three equal 50-degree sections separated by equal 15-degree gaps.
`orchestra-broken-arches-v3-v1-proportions-equal-sections.png` returns to the
preferred v1 silhouette and changes only the internal split positions so the
three pieces within each individual arch are equal-length; the three arches
retain their different overall scales.
`orchestra-broken-arches-v4-exact.svg` is the deterministic correction. Each
arch defines one annular-section path and reuses it three times, making its
three pieces mathematically identical in arc length. The outer, middle, and
inner sections span 44°, 40°, and 36° respectively, preserving the visual
scale progression between arches. Its PNG is rendered directly from that SVG.
`orchestra-broken-arches-v5-imagegen-reference-equal-sections.png` returns to
the operator-supplied raster as the exact visual target and uses built-in
ImageGen to equalize the three pieces within each arch while preserving the
reference's softer proportions and finish.
Production assets under `brand/identity/` remain unchanged.
