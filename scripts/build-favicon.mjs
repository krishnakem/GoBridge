#!/usr/bin/env node
/**
 * Builds the derived icon files in assets/logo/ from the master PNG:
 *
 *   assets/logo/apple-touch-icon.png   180x180
 *   assets/logo/favicon.ico            16 + 32 + 48 px, PNG-compressed entries
 *
 * Run it once after the artwork changes and commit the results; the Worker
 * bundles the committed files (see wrangler.jsonc "rules"), so this is a
 * build-time step with no runtime dependency. Resizing uses macOS `sips`
 * (no npm package); the ICO container is written by hand below.
 *
 *   node scripts/build-favicon.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const logoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets", "logo");
const master = join(logoDir, "logo-1024.png");

function resize(size, out) {
	execFileSync("sips", ["-z", String(size), String(size), master, "--out", out], {
		stdio: ["ignore", "ignore", "inherit"],
	});
	return readFileSync(out);
}

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

const work = mkdtempSync(join(tmpdir(), "gobridge-favicon-"));
try {
	resize(180, join(logoDir, "apple-touch-icon.png"));
	const ico = buildIco([
		{ size: 16, png: resize(16, join(work, "16.png")) },
		{ size: 32, png: readFileSync(join(logoDir, "logo-32.png")) },
		{ size: 48, png: resize(48, join(work, "48.png")) },
	]);
	writeFileSync(join(logoDir, "favicon.ico"), ico);
	console.log(`wrote apple-touch-icon.png and favicon.ico (${ico.length} bytes)`);
} finally {
	rmSync(work, { recursive: true, force: true });
}
