import type { R2Bucket } from '@cloudflare/workers-types';
import { PhotonImage, resize, draw_text_with_border, SamplingFilter } from '@cf-wasm/photon/workerd';
import type { WatermarkConfig } from './db';

export interface ProcessOptions {
	width?: number;
	height?: number;
	quality?: number;
	watermark?: boolean;
}

const DEFAULT_QUALITY = 80;
const MAX_DIM = 4000;
// Photon 解码大图可能 OOM，超过此大小的文件跳过转换
const MAX_CONVERT_SIZE = 2 * 1024 * 1024;

/** 上传：Photon 转 JPEG (有损压缩，质量可控)。超大文件跳过以免 OOM */
export async function convertToWebp(
	inputBytes: Uint8Array,
	quality: number,
): Promise<{ data: Uint8Array; width: number; height: number } | null> {
	try {
		let image = PhotonImage.new_from_byteslice(inputBytes);
		try {
			let w = image.get_width(), h = image.get_height();

			// 超大图先缩放
			if (w > MAX_DIM || h > MAX_DIM) {
				const ratio = Math.min(MAX_DIM / w, MAX_DIM / h);
				w = Math.round(w * ratio);
				h = Math.round(h * ratio);
				const r = resize(image, w, h, SamplingFilter.Lanczos3);
				image.free();
				image = r;
			}

			const jpegBytes = image.get_bytes_jpeg(quality);
			return { data: jpegBytes, width: w, height: h };
		} finally {
			image.free();
		}
	} catch {
		return null;
	}
}

/** 服务端缩放 → JPEG (Photon，质量可控) */
export async function resizeImage(
	bucket: R2Bucket,
	key: string,
	opts: ProcessOptions,
): Promise<{ body: Uint8Array; contentType: string } | null> {
	const object = await bucket.get(key);
	if (!object) return null;

	// 快速路径：原图不太大时直接用 Photon
	const inputBytes = new Uint8Array(await object.arrayBuffer());

	// 如果文件太大，可能 OOM，降级返回原图
	if (inputBytes.length > MAX_CONVERT_SIZE) {
		return null;
	}

	try {
		let image = PhotonImage.new_from_byteslice(inputBytes);
		try {
			let w = image.get_width(), h = image.get_height();

			if (opts.width || opts.height) {
				w = opts.width ?? Math.round(image.get_width() * (opts.height! / image.get_height()));
				h = opts.height ?? Math.round(image.get_height() * (opts.width! / image.get_width()));
				const r = resize(image, w, h, SamplingFilter.Lanczos3);
				image.free();
				image = r;
			}

			// 缩略图用 lossless WebP（小图上无损也小），原尺寸用 JPEG
			const q = opts.quality ?? DEFAULT_QUALITY;
			if (w <= 1200 && h <= 1200) {
				const webpBytes = image.get_bytes_webp();
				return { body: webpBytes, contentType: 'image/webp' };
			}
			const jpegBytes = image.get_bytes_jpeg(q);
			return { body: jpegBytes, contentType: 'image/jpeg' };
		} finally {
			image.free();
		}
	} catch {
		return null;
	}
}

/** 缩放 + 文字水印 */
export async function resizeWithWatermark(
	bucket: R2Bucket,
	key: string,
	opts: ProcessOptions,
	wmConfig: WatermarkConfig,
): Promise<{ body: Uint8Array; contentType: string } | null> {
	const object = await bucket.get(key);
	if (!object) return null;

	const inputBytes = new Uint8Array(await object.arrayBuffer());
	if (inputBytes.length > MAX_CONVERT_SIZE) return null;

	try {
		let image = PhotonImage.new_from_byteslice(inputBytes);
		try {
			let w = image.get_width(), h = image.get_height();

			if (opts.width || opts.height) {
				w = opts.width ?? Math.round(w * (opts.height! / h));
				h = opts.height ?? Math.round(h * (opts.width! / w));
				const r = resize(image, w, h, SamplingFilter.Lanczos3);
				image.free();
				image = r;
			}

			// 文字水印
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

			// 缩略图 WebP，大图 JPEG
			if (w <= 1200) {
				return { body: image.get_bytes_webp(), contentType: 'image/webp' };
			}
			return { body: image.get_bytes_jpeg(opts.quality ?? DEFAULT_QUALITY), contentType: 'image/jpeg' };
		} finally {
			image.free();
		}
	} catch {
		return null;
	}
}
