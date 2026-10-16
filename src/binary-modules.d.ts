/**
 * The logo files under assets/logo/ are bundled into the Worker as Data
 * modules (wrangler.jsonc "rules"), so importing one gives its raw bytes.
 */
declare module "*.png" {
	const bytes: ArrayBuffer;
	export default bytes;
}
declare module "*.svg" {
	const bytes: ArrayBuffer;
	export default bytes;
}
declare module "*.ico" {
	const bytes: ArrayBuffer;
	export default bytes;
}
