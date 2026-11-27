//! Text extraction for uploaded files (PDF, Word .docx, PowerPoint .pptx), with OCR
//! (`ocr.rs`) for scanned PDF pages and pictures.
//!
//! The text goes into the upload's note, so search, "Copy context for AI", link
//! suggestions and the AI agents all see it. Extraction is best effort: a file we can't
//! read still uploads, just without text.

use std::io::{Cursor, Read};
use std::sync::LazyLock;

use regex::Regex;

/// Notes stay readable: keep at most this many characters of extracted text.
pub const MAX_TEXT_CHARS: usize = 400_000;

/// One block of extracted text: a page or slide (`label`) and its text.
#[derive(Debug, Clone, PartialEq)]
pub struct Part {
    pub label: String,
    pub text: String,
}

/// Extract text from a file by its name's extension. `None` if the type isn't
/// supported or nothing readable was found.
pub fn extract(file_name: &str, bytes: &[u8]) -> Option<Vec<Part>> {
    let lower = file_name.to_lowercase();
    let parts = if lower.ends_with(".pdf") {
        pdf(bytes)
    } else if lower.ends_with(".docx") {
        docx(bytes)
    } else if lower.ends_with(".pptx") {
        pptx(bytes)
    } else if [".png", ".jpg", ".jpeg", ".webp"]
        .iter()
        .any(|e| lower.ends_with(e))
    {
        let text = crate::ocr::read_image(bytes)?;
        Some(vec![Part {
            label: "Text in the picture".into(),
            text,
        }])
    } else {
        None
    }?;
    let parts: Vec<Part> = parts
        .into_iter()
        .map(|p| Part {
            label: p.label,
            text: tidy(&p.text),
        })
        .filter(|p| !p.text.is_empty())
        .collect();
    (!parts.is_empty()).then_some(parts)
}

/// Turn extracted parts into note Markdown. Characters that would become links, tags or
/// headings in the note are escaped, so a file's text can't create connections or
/// structure by accident; only real mentions (found by link suggestions) do.
pub fn to_markdown(parts: &[Part]) -> String {
    let mut out = String::new();
    let mut used = 0;
    for p in parts {
        if used >= MAX_TEXT_CHARS {
            out.push_str("\n*(The rest of the file's text was cut to keep this note small.)*\n");
            break;
        }
        let take: String = p.text.chars().take(MAX_TEXT_CHARS - used).collect();
        used += take.chars().count();
        out.push_str(&format!("\n### {}\n\n{}\n", p.label, escape(&take)));
    }
    out
}

fn escape(text: &str) -> String {
    let mut s = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '[' | ']' | '#' | '^' | '<' | '>' | '`' | '*' | '_' | '|' => {
                s.push('\\');
                s.push(c);
            }
            _ => s.push(c),
        }
    }
    s
}

/// Collapse runs of spaces and blank lines, drop control characters.
fn tidy(text: &str) -> String {
    static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \t\u{a0}]+").unwrap());
    static BLANKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n\s*\n(\s*\n)+").unwrap());
    let clean: String = text
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect();
    let lines: Vec<String> = clean
        .lines()
        .map(|l| SPACES.replace_all(l, " ").trim().to_string())
        .collect();
    BLANKS.replace_all(&lines.join("\n"), "\n\n").trim().to_string()
}

fn pdf(bytes: &[u8]) -> Option<Vec<Part>> {
    // The PDF library can panic on unusual files; an upload must never crash the app.
    let pages: Option<Vec<String>> =
        std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem_by_pages(bytes))
            .ok()
            .and_then(Result::ok);
    // Pages with (almost) no text layer are usually scans: read them with OCR.
    let wanted: Vec<u32> = match &pages {
        Some(p) => p
            .iter()
            .enumerate()
            .filter(|(_, t)| t.split_whitespace().map(str::len).sum::<usize>() < 20)
            .map(|(i, _)| i as u32 + 1)
            .collect(),
        None => (1..=crate::ocr::MAX_OCR_PAGES as u32).collect(),
    };
    let scanned: std::collections::HashMap<u32, String> =
        crate::ocr::read_pdf_pages(bytes, &wanted).into_iter().collect();
    let count = pages
        .as_ref()
        .map(Vec::len)
        .unwrap_or_else(|| scanned.keys().max().copied().unwrap_or(0) as usize);
    let parts: Vec<Part> = (1..=count as u32)
        .filter_map(|n| match scanned.get(&n) {
            Some(t) => Some(Part {
                label: format!("Page {n} (read from the scan)"),
                text: t.clone(),
            }),
            None => pages.as_ref().and_then(|p| p.get(n as usize - 1)).map(|t| Part {
                label: format!("Page {n}"),
                text: t.clone(),
            }),
        })
        .collect();
    Some(parts)
}

fn docx(bytes: &[u8]) -> Option<Vec<Part>> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).ok()?;
    let xml = read_entry(&mut zip, "word/document.xml")?;
    Some(vec![Part {
        label: "Document".into(),
        text: xml_text(&xml, "w:t", "w:p"),
    }])
}

fn pptx(bytes: &[u8]) -> Option<Vec<Part>> {
    static SLIDE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^ppt/slides/slide(\d+)\.xml$").unwrap());
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).ok()?;
    let mut slides: Vec<(u32, String)> = zip
        .file_names()
        .filter_map(|n| {
            let n = n.ok()?;
            let num = SLIDE.captures(&n)?[1].parse().ok()?;
            Some((num, n.to_string()))
        })
        .collect();
    slides.sort();
    let mut parts = Vec::new();
    for (num, name) in slides {
        let xml = read_entry(&mut zip, &name)?;
        let mut text = xml_text(&xml, "a:t", "a:p");
        let notes = format!("ppt/notesSlides/notesSlide{num}.xml");
        if let Some(nx) = read_entry(&mut zip, &notes) {
            let n = xml_text(&nx, "a:t", "a:p");
            // Speaker notes repeat the slide number as their only text when empty.
            if n.trim() != num.to_string() && !n.trim().is_empty() {
                text.push_str("\n\nSpeaker notes:\n");
                text.push_str(&n);
            }
        }
        parts.push(Part {
            label: format!("Slide {num}"),
            text,
        });
    }
    Some(parts)
}

fn read_entry<R: Read + std::io::Seek>(zip: &mut zip::ZipArchive<R>, name: &str) -> Option<String> {
    let mut f = zip.by_name(name).ok()?;
    // Guard against zip bombs: an Office XML part over 50 MB isn't a normal document.
    let mut s = String::new();
    f.by_ref().take(50 * 1024 * 1024).read_to_string(&mut s).ok()?;
    Some(s)
}

/// Text inside `<run>…</run>` elements, with a line break at the end of each `<para>`.
fn xml_text(xml: &str, run: &str, para: &str) -> String {
    let re = Regex::new(&format!(
        r"<{run}(?:\s[^>]*)?>([^<]*)</{run}>|</{para}>|<{para}\s[^>]*/>|<{para}/>",
        run = regex::escape(run),
        para = regex::escape(para)
    ))
    .expect("valid regex");
    let mut out = String::new();
    for cap in re.captures_iter(xml) {
        match cap.get(1) {
            Some(t) => out.push_str(&unescape(t.as_str())),
            None => out.push('\n'),
        }
    }
    out
}

fn unescape(s: &str) -> String {
    static ENTITY: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);").unwrap());
    ENTITY
        .replace_all(s, |c: &regex::Captures| {
            let e = &c[1];
            match e {
                "amp" => "&".to_string(),
                "lt" => "<".to_string(),
                "gt" => ">".to_string(),
                "quot" => "\"".to_string(),
                "apos" => "'".to_string(),
                _ => {
                    let n = if let Some(h) = e.strip_prefix("#x") {
                        u32::from_str_radix(h, 16).ok()
                    } else {
                        e[1..].parse().ok()
                    };
                    n.and_then(char::from_u32).map(String::from).unwrap_or_default()
                }
            }
        })
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn office(files: &[(&str, &str)]) -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            for (name, body) in files {
                z.start_file(*name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                z.write_all(body.as_bytes()).unwrap();
            }
            z.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn reads_word_paragraphs_and_entities() {
        let doc = office(&[(
            "word/document.xml",
            r#"<w:document><w:body><w:p><w:r><w:t>Launch Plan</w:t></w:r><w:r><w:t xml:space="preserve"> for Q3</w:t></w:r></w:p><w:p><w:r><w:t>Budget &amp; scope</w:t></w:r></w:p></w:body></w:document>"#,
        )]);
        let parts = extract("Brief.DOCX", &doc).unwrap();
        assert_eq!(parts[0].text, "Launch Plan for Q3\nBudget & scope");
    }

    #[test]
    fn reads_slides_in_order_with_speaker_notes() {
        let p = office(&[
            (
                "ppt/slides/slide10.xml",
                "<p:sld><a:p><a:r><a:t>Ten</a:t></a:r></a:p></p:sld>",
            ),
            (
                "ppt/slides/slide2.xml",
                "<p:sld><a:p><a:r><a:t>Two</a:t></a:r></a:p></p:sld>",
            ),
            (
                "ppt/notesSlides/notesSlide2.xml",
                "<a:p><a:r><a:t>Say hello</a:t></a:r></a:p>",
            ),
        ]);
        let parts = extract("deck.pptx", &p).unwrap();
        assert_eq!(
            parts.iter().map(|p| p.label.as_str()).collect::<Vec<_>>(),
            ["Slide 2", "Slide 10"]
        );
        assert!(parts[0].text.contains("Speaker notes:\nSay hello"));
    }

    #[test]
    fn bad_files_give_nothing_instead_of_crashing() {
        assert!(extract("x.pdf", b"not a pdf").is_none());
        assert!(extract("x.docx", b"not a zip").is_none());
        assert!(extract("x.png", b"\x89PNG").is_none());
    }

    #[test]
    fn text_cannot_create_links_tags_or_headings() {
        let md = to_markdown(&[Part {
            label: "Page 1".into(),
            text: "# Big\nsee [[Secret]] #tag".into(),
        }]);
        let note = crate::parse::parse(&format!("---\nx: 1\n---\n{md}"));
        assert!(note.links.is_empty(), "{:?}", note.links);
        assert!(note.tags.is_empty());
        assert_eq!(note.headings.len(), 1, "only the page heading");
        assert!(md.contains("\\[\\[Secret\\]\\]"));
    }
}
