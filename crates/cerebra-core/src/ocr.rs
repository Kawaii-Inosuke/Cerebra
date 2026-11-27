//! OCR: reads text from scanned PDF pages and uploaded images with PaddleOCR (PP-OCRv6
//! small, Apache-2.0) running locally through ONNX Runtime. Nothing leaves the computer.
//!
//! The models are downloaded by `scripts/fetch-models.mjs` (the app does it on first use);
//! the caller tells us where with [`set_models_dir`]. Without models, or on Intel Macs (no
//! ONNX Runtime build), OCR is simply unavailable and uploads still work.

use std::path::PathBuf;
use std::sync::OnceLock;

static MODELS_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Pages bigger than this (pixels per side) are scaled down first; OCR doesn't need more.
#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
const MAX_SIDE: u32 = 2400;
/// Upper bound on scanned pages read from one PDF, so a huge scan can't stall an upload.
pub const MAX_OCR_PAGES: usize = 300;

/// Where the models are: the same root folder `semantic::set_models_dir` takes (OCR files are
/// in its `ocr/` subfolder). Call once at startup; later calls are ignored.
pub fn set_models_dir(root: PathBuf) {
    let _ = MODELS_DIR.set(ocr_dir(&root));
}

fn ocr_dir(root: &std::path::Path) -> PathBuf {
    root.join("ocr")
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
mod engine {
    use std::sync::{Mutex, OnceLock};

    use image::RgbImage;
    use oar_ocr::domain::tasks::text_detection::TextDetectionConfig;
    use oar_ocr::prelude::*;

    use super::{MAX_SIDE, MODELS_DIR};

    const DET: &str = "pp-ocrv6_small_det.onnx";
    const REC: &str = "pp-ocrv6_small_rec.onnx";
    const DICT: &str = "ppocrv6_dict.txt";

    static ENGINE: OnceLock<Option<Mutex<OAROCR>>> = OnceLock::new();

    fn engine() -> Option<&'static Mutex<OAROCR>> {
        ENGINE
            .get_or_init(|| {
                let dir = MODELS_DIR.get()?;
                if ![DET, REC, DICT].iter().all(|f| dir.join(f).is_file()) {
                    return None;
                }
                // Official PP-OCRv6 detection settings (PaddleOCR DBPostProcess).
                let config = TextDetectionConfig {
                    score_threshold: 0.2,
                    box_threshold: 0.45,
                    unclip_ratio: 1.4,
                    max_candidates: 3000,
                    ..TextDetectionConfig::default()
                };
                let built = std::panic::catch_unwind(|| {
                    OAROCRBuilder::new(dir.join(DET), dir.join(REC), dir.join(DICT))
                        .text_detection_config(config)
                        .build()
                });
                match built {
                    Ok(Ok(ocr)) => Some(Mutex::new(ocr)),
                    Ok(Err(e)) => {
                        eprintln!("OCR unavailable: {e}");
                        None
                    }
                    Err(_) => None,
                }
            })
            .as_ref()
    }

    pub fn available() -> bool {
        engine().is_some()
    }

    /// Text of one image, line by line in reading order.
    pub fn read(img: RgbImage) -> Option<String> {
        let img = shrink(img);
        if img.width() < 16 || img.height() < 16 {
            return None;
        }
        let ocr = engine()?.lock().ok()?;
        let pages =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| ocr.predict_with_rows(vec![img])))
                .ok()?
                .ok()?;
        let p = pages.into_iter().next()?;
        p.page.text_by_rows(&p.row_ids).ok()
    }

    fn shrink(img: RgbImage) -> RgbImage {
        let (w, h) = img.dimensions();
        if w.max(h) <= MAX_SIDE {
            return img;
        }
        let scale = MAX_SIDE as f32 / w.max(h) as f32;
        image::imageops::resize(
            &img,
            ((w as f32 * scale) as u32).max(1),
            ((h as f32 * scale) as u32).max(1),
            image::imageops::FilterType::Triangle,
        )
    }

    pub fn decode(bytes: &[u8]) -> Option<RgbImage> {
        // Refuse absurd sizes before decoding (decompression bombs).
        let reader = image::ImageReader::new(std::io::Cursor::new(bytes))
            .with_guessed_format()
            .ok()?;
        let (w, h) = reader.into_dimensions().ok()?;
        if u64::from(w) * u64::from(h) > 80_000_000 {
            return None;
        }
        Some(image::load_from_memory(bytes).ok()?.to_rgb8())
    }

    /// The images drawn on each page of a PDF, in page order (1-based page numbers).
    pub fn pdf_page_images(bytes: &[u8], wanted: &[u32]) -> Vec<(u32, Vec<RgbImage>)> {
        let Ok(doc) = lopdf::Document::load_mem(bytes) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for (num, id) in doc.get_pages() {
            if !wanted.contains(&num) {
                continue;
            }
            let Ok(imgs) = doc.get_page_images(id) else {
                continue;
            };
            let mut decoded = Vec::new();
            for img in imgs {
                // Small images are logos and icons, not scanned text.
                if img.width < 200 || img.height < 100 {
                    continue;
                }
                let filters = img.filters.clone().unwrap_or_default();
                let rgb = if filters.iter().any(|f| f == "DCTDecode") {
                    decode(img.content)
                } else if filters.is_empty() || filters.iter().all(|f| f == "FlateDecode") {
                    raw_pixels(&doc, &img)
                } else {
                    None // JPEG 2000, fax-encoded and other formats aren't read yet
                };
                decoded.extend(rgb);
            }
            if !decoded.is_empty() {
                out.push((num, decoded));
            }
        }
        out
    }

    /// Uncompressed 8-bit RGB or greyscale image data.
    fn raw_pixels(doc: &lopdf::Document, img: &lopdf::xobject::PdfImage) -> Option<RgbImage> {
        if img.bits_per_component != Some(8) {
            return None;
        }
        let (w, h) = (u32::try_from(img.width).ok()?, u32::try_from(img.height).ok()?);
        if u64::from(w) * u64::from(h) > 80_000_000 {
            return None;
        }
        let data = doc
            .get_object(img.id)
            .ok()?
            .as_stream()
            .ok()?
            .decompressed_content()
            .ok()?;
        match img.color_space.as_deref() {
            Some("DeviceRGB") => RgbImage::from_raw(w, h, data.get(..(w * h * 3) as usize)?.to_vec()),
            Some("DeviceGray") => {
                let grey = image::GrayImage::from_raw(w, h, data.get(..(w * h) as usize)?.to_vec())?;
                Some(image::DynamicImage::ImageLuma8(grey).to_rgb8())
            }
            _ => None,
        }
    }
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
pub use engine::available;

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
pub fn available() -> bool {
    false
}

/// Text from an uploaded image file (PNG, JPEG, WebP).
pub fn read_image(bytes: &[u8]) -> Option<String> {
    #[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
    {
        let text = engine::read(engine::decode(bytes)?)?;
        return (!text.trim().is_empty()).then_some(text);
    }
    #[allow(unreachable_code)]
    {
        let _ = bytes;
        None
    }
}

/// OCR text for the given PDF pages (1-based), for pages that are pictures of text.
pub fn read_pdf_pages(bytes: &[u8], pages: &[u32]) -> Vec<(u32, String)> {
    #[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
    {
        if pages.is_empty() || !available() {
            return Vec::new();
        }
        let pages: Vec<u32> = pages.iter().copied().take(MAX_OCR_PAGES).collect();
        return engine::pdf_page_images(bytes, &pages)
            .into_iter()
            .filter_map(|(num, imgs)| {
                let text: Vec<String> = imgs.into_iter().filter_map(engine::read).collect();
                let text = text.join("\n\n");
                (!text.trim().is_empty()).then_some((num, text))
            })
            .collect();
    }
    #[allow(unreachable_code)]
    {
        let _ = (bytes, pages);
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ocr_files_live_in_the_ocr_subfolder_of_the_models_root() {
        assert_eq!(ocr_dir(std::path::Path::new("/m")), PathBuf::from("/m/ocr"));
    }
}
