import type { R2Bucket } from '@cloudflare/workers-types';
import { PhotonImage, draw_text_with_border } from '@cf-wasm/photon/workerd';
import { ready, decode, resize } from '@standardagents/sip';
import type { WatermarkConfig } from './db';

// jsquash libwebp — lossy WebP encode (Cloudflare Workers compatible)
import encodeWebp, { init as initWebpEnc } from '@jsquash/webp/encode';
// @ts-expect-error WASM binary — Wrangler resolves relative to src/
import WEBP_ENC_WASM from '../node_modules/@jsquash/webp/codec/enc/webp_enc_simd.wasm';

export interface ProcessOptions {
	width?: number;
	height?: number;
	quality?: number;
	watermark?: boolean;
}

const DEFAULT_QUALITY = 80;
const MAX_DIM = 4000;

let _ready = false;
async function ensureReady() {
	if (_ready) return;
	await Promise.all([ready(), initWebpEnc(WEBP_ENC_WASM)]);
	_ready = true;
}

interface PixelData { data: Uint8ClampedArray; width: number; height: number }

async function collectImageData(
	stream: AsyncIterable<{ data: Uint8Array; width: number; y: number }>,
	imgWidth: number, imgHeight: number,
): Promise<PixelData> {
	const rgba = new Uint8ClampedArray(imgWidth * imgHeight * 4);
	for await (const row of stream) {
		let s = 0, d = row.y * imgWidth * 4;
		const end = row.width * 3;
		while (s < end) {
			rgba[d++] = row.data[s++];
			rgba[d++] = row.data[s++];
			rgba[d++] = row.data[s++];
			rgba[d++] = 255;
		}
	}
	return { data: rgba, width: imgWidth, height: imgHeight };
}

/** 上传：SIP 流式缩放 + jsquash 有损 WebP 编码 */
export async function convertToWebp(
	inputBytes: Uint8Array, quality: number,
): Promise<{ data: Uint8Array; width: number; height: number } | null> {
	try {
		await ensureReady();
		let stream = decode(inputBytes);
		const info = await stream.info;
		let w = info.width, h = info.height;

		if (w > MAX_DIM || h > MAX_DIM) {
			const ratio = Math.min(MAX_DIM / w, MAX_DIM / h);
			w = Math.round(w * ratio); h = Math.round(h * ratio);
			stream = resize(stream, { width: w, height: h });
		}

		const imageData = await collectImageData(stream, w, h);
		const webpBytes = await encodeWebp(imageData, { quality, method: 3 });
		return { data: new Uint8Array(webpBytes), width: w, height: h };
	} catch { return null; }
}

/** 服务端缩放 → WebP */
export async function resizeImage(
	bucket: R2Bucket, key: string, opts: ProcessOptions,
): Promise<{ body: Uint8Array; contentType: string } | null> {
	const object = await bucket.get(key);
	if (!object) return null;
	try {
		await ensureReady();
		const inputBytes = new Uint8Array(await object.arrayBuffer());
		let stream = decode(inputBytes);
		const info = await stream.info;
		let w = info.width, h = info.height;

		if (opts.width || opts.height) {
			w = opts.width ?? Math.round(info.width * (opts.height! / info.height));
			h = opts.height ?? Math.round(info.height * (opts.width! / info.width));
			stream = resize(stream, { width: w, height: h });
		}

		const imageData = await collectImageData(stream, w, h);
		const webpBytes = await encodeWebp(imageData, { quality: opts.quality ?? DEFAULT_QUALITY, method: 2 });
		return { body: new Uint8Array(webpBytes), contentType: 'image/webp' };
	} catch { return null; }
}

/** 缩放 + 文字水印 → WebP */
export async function resizeWithWatermark(
	bucket: R2Bucket, key: string, opts: ProcessOptions, wmConfig: WatermarkConfig,
): Promise<{ body: Uint8Array; contentType: string } | null> {
	const resized = await resizeImage(bucket, key, opts);
	if (!resized) return null;
	try {
		const image = PhotonImage.new_from_byteslice(resized.body);
		try {
			const fs = Math.min(200, Math.max(8, wmConfig.fontSize || 24));
			const imgW = image.get_width(), imgH = image.get_height();
			const textW = Math.floor(wmConfig.text.length * fs * 0.6);
			const padding = 20;
			let x: number, y: number;
			switch (wmConfig.position) {
				case 'tl': x = padding; y = padding + fs; break;
				case 'tr': x = imgW - textW - padding; y = padding + fs; break;
				case 'bl': x = padding; y = imgH - padding; break;
				case 'center': x = Math.floor((imgW - textW) / 2); y = Math.floor((imgH + fs) / 2); break;
				case 'br': default: x = imgW - textW - padding; y = imgH - padding; break;
			}
			draw_text_with_border(image, wmConfig.text, x, y, fs);
			const out = image.get_bytes_webp();
			return { body: out, contentType: 'image/webp' };
		} finally { image.free(); }
	} catch { return resized; }
}
