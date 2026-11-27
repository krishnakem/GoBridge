#!/usr/bin/env node
/**
 * Builds the favicon / web-manifest icon set in assets/logo/ from the master
 * SVG (assets/logo/logo.svg):
 *
 *   assets/logo/favicon.svg            the logo as a full-bleed square
 *   assets/logo/favicon-64.png         64x64    (served at /favicon.png)
 *   assets/logo/apple-touch-icon.png   180x180
 *   assets/logo/icon-192.png           192x192  (web manifest, MCP serverInfo)
 *   assets/logo/icon-512.png           512x512  (web manifest)
 *   assets/logo/favicon.ico            16 + 32 + 48 px, PNG-compressed entries
 *
 * Every file here is OPAQUE. Favicon services and AI clients composite icons
 * on their own background (often white) and apply their own mask (rounded
 * square, circle), so a transparent rounded corner turns into a visible
 * notch. The master SVG clips its artwork to a rounded square, but the sky and
 * sea underneath extend past that clip, so dropping the clip's corner radius
 * gives a full-bleed square without losing or stretching any of the drawing.
 * The PNGs are then written as 8-bit RGB with no alpha channel at all.
 *
 * logo.svg, logo-256.png and logo-512.png (the rounded, transparent logo used
 * on GoBridge's own pages and in MCP serverInfo.icons) are NOT touched.
 *
 * Run it once after the artwork changes and commit the results; the Worker
 * bundles the committed files (see wrangler.jsonc "rules"), so this is a
 * build-time step with no runtime dependency. Rasterising uses macOS `sips`
 * (no npm package); PNG re-encoding and the ICO container are written by hand
 * below with node:zlib.
 *
 *   node scripts/build-favicon.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const logoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets", "logo");

// ---------- Square SVG ----------

/** The one rounded clip in logo.svg; the square version keeps the same box with no radius. */
const ROUNDED_CLIP = /<clipPath id="cl"><rect x="0" y="74" width="400" height="400" rx="[\d.]+"\/><\/clipPath>/;
const SQUARE_CLIP = '<clipPath id="cl"><rect x="0" y="74" width="400" height="400"/></clipPath>';

function squareSvg() {
	const source = readFileSync(join(logoDir, "logo.svg"), "utf8");
	if (!ROUNDED_CLIP.test(source)) throw new Error("logo.svg: rounded clip not found; update ROUNDED_CLIP");
	return (
		source
			.replace(ROUNDED_CLIP, SQUARE_CLIP)
			// The provenance manifest hashes the original bytes; it no longer
			// describes this derived file, so it is left out rather than kept stale.
			.replace(/<metadata>[\s\S]*?<\/metadata>/, "")
			.replace(/ xmlns:c2pa="[^"]*"/, "")
	);
}

// ---------- PNG decode / encode (8-bit, non-interlaced) ----------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
function crc32(bytes) {
	let c = 0xffffffff;
	for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decodes an 8-bit RGB or RGBA PNG into { width, height, channels, pixels }. */
function decodePng(bytes) {
	if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG");
	let width = 0;
	let height = 0;
	let channels = 0;
	const idat = [];
	for (let at = 8; at < bytes.length; ) {
		const length = bytes.readUInt32BE(at);
		const type = bytes.toString("latin1", at + 4, at + 8);
		const data = bytes.subarray(at + 8, at + 8 + length);
		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			const [depth, colourType, , , interlace] = data.subarray(8, 13);
			if (depth !== 8 || interlace !== 0 || (colourType !== 2 && colourType !== 6)) {
				throw new Error(`unsupported PNG: depth ${depth}, colour type ${colourType}, interlace ${interlace}`);
			}
			channels = colourType === 6 ? 4 : 3;
		} else if (type === "IDAT") {
			idat.push(data);
		}
		at += 12 + length;
	}
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	const pixels = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		for (let x = 0; x < stride; x++) {
			const left = x >= channels ? pixels[y * stride + x - channels] : 0;
			const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
			const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
			const predictor = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter];
			if (predictor === undefined) throw new Error(`bad PNG filter ${filter}`);
			pixels[y * stride + x] = (line[x] + predictor) & 0xff;
		}
	}
	return { width, height, channels, pixels };
}

/** RGB pixels from decoded RGB(A), with any partial transparency composited onto white. */
function opaqueRgb({ width, height, channels, pixels }) {
	const rgb = Buffer.alloc(width * height * 3);
	for (let i = 0; i < width * height; i++) {
		const alpha = channels === 4 ? pixels[i * 4 + 3] / 255 : 1;
		for (let c = 0; c < 3; c++) {
			rgb[i * 3 + c] = Math.round(pixels[i * channels + c] * alpha + 255 * (1 - alpha));
		}
	}
	return rgb;
}

function chunk(type, data) {
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, "latin1");
	data.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
}

/** Encodes 8-bit RGB pixels (colour type 2, no alpha channel) as a PNG. */
function encodeRgbPng(width, height, rgb) {
	const stride = width * 3;
	const rows = [];
	for (let y = 0; y < height; y++) {
		const line = rgb.subarray(y * stride, (y + 1) * stride);
		const prev = y > 0 ? rgb.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
		// Pick the filter with the smallest sum of absolute differences (libpng's heuristic).
		let best = null;
		for (let filter = 0; filter < 5; filter++) {
			const out = Buffer.alloc(stride + 1);
			out[0] = filter;
			let score = 0;
			for (let x = 0; x < stride; x++) {
				const left = x >= 3 ? line[x - 3] : 0;
				const up = prev[x];
				const upLeft = x >= 3 ? prev[x - 3] : 0;
				const predictor = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter];
				const value = (line[x] - predictor) & 0xff;
				out[x + 1] = value;
				score += value < 128 ? value : 256 - value;
			}
			if (!best || score < best.score) best = { score, out };
		}
		rows.push(best.out);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr.set([8, 2, 0, 0, 0], 8); // depth 8, RGB, deflate, adaptive filtering, no interlace
	return Buffer.concat([
		PNG_SIGNATURE,
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

// ---------- ICO ----------

/** ICO container: 6-byte header, 16-byte directory entry per image, then the PNG bytes. */
function buildIco(images) {
	const header = Buffer.alloc(6);
	header.writeUInt16LE(0, 0); // reserved
	header.writeUInt16LE(1, 2); // type: icon
	header.writeUInt16LE(images.length, 4);
	const directory = Buffer.alloc(16 * images.length);
	let offset = header.length + directory.length;
	images.forEach(({ size, png }, i) => {
		const entry = directory.subarray(i * 16, (i + 1) * 16);
		entry.writeUInt8(size === 256 ? 0 : size, 0); // width
		entry.writeUInt8(size === 256 ? 0 : size, 1); // height
		entry.writeUInt8(0, 2); // palette size
		entry.writeUInt8(0, 3); // reserved
		entry.writeUInt16LE(1, 4); // colour planes
		entry.writeUInt16LE(32, 6); // bits per pixel
		entry.writeUInt32LE(png.length, 8);
		entry.writeUInt32LE(offset, 12);
		offset += png.length;
	});
	return Buffer.concat([header, directory, ...images.map((image) => image.png)]);
}

// ---------- Build ----------

const work = mkdtempSync(join(tmpdir(), "gobridge-favicon-"));
try {
	const svgPath = join(logoDir, "favicon.svg");
	writeFileSync(svgPath, squareSvg());

	/** Rasterises the square SVG at `size` px (sips renders SVG directly) and returns an opaque RGB PNG. */
	const render = (size) => {
		const out = join(work, `${size}.png`);
		execFileSync("sips", ["-s", "format", "png", "-z", String(size), String(size), svgPath, "--out", out], {
			stdio: ["ignore", "ignore", "inherit"],
		});
		const decoded = decodePng(readFileSync(out));
		if (decoded.width !== size || decoded.height !== size) throw new Error(`sips gave ${decoded.width}x${decoded.height} for ${size}`);
		return encodeRgbPng(size, size, opaqueRgb(decoded));
	};

	const outputs = {
		"favicon-64.png": render(64),
		"apple-touch-icon.png": render(180),
		"icon-192.png": render(192),
		"icon-512.png": render(512),
		"favicon.ico": buildIco([16, 32, 48].map((size) => ({ size, png: render(size) }))),
	};
	for (const [name, bytes] of Object.entries(outputs)) writeFileSync(join(logoDir, name), bytes);
	console.log(`wrote favicon.svg, ${Object.keys(outputs).join(", ")}`);
} finally {
	rmSync(work, { recursive: true, force: true });
}
