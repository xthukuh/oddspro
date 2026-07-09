// Regenerates the raster favicons from the SVG source of truth
// (web/public/icon.svg). The "[OP]" mark lives in the SVG; this only
// rasterizes it to the formats browsers still need.
//
// sharp + png-to-ico are NOT project dependencies (one-off asset tooling,
// no need to bloat every install). Run with npx, which fetches them on the
// fly:
//
//   npx --yes --package=sharp --package=png-to-ico node scripts/gen-icons.js
//
// Outputs (committed): web/public/icon.png (512, doubles as PWA/apple-touch)
// and web/public/favicon.ico (16/32/48). Edit icon.svg, then rerun this.

import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PUBLIC = path.resolve(import.meta.dirname, '..', 'web', 'public');
const svg = readFileSync(path.join(PUBLIC, 'icon.svg'));

// density lifts the rasterizer's DPI so the vector is sampled sharply
// before the downscale (avoids fuzzy small sizes).
const png = size => sharp(svg, { density: 384 }).resize(size, size).png().toBuffer();

writeFileSync(path.join(PUBLIC, 'icon.png'), await png(512));
writeFileSync(path.join(PUBLIC, 'favicon.ico'), await pngToIco(await Promise.all([16, 32, 48].map(png))));

console.log('gen-icons: wrote web/public/icon.png (512) + favicon.ico (16/32/48)');
