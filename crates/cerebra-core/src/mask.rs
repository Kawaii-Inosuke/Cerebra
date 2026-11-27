//! Masks regions where Obsidian syntax must NOT be recognised: fenced code blocks,
//! inline code spans and `%% comments %%`.
//!
//! Masking replaces those bytes with spaces (newlines are kept), so byte offsets and
//! line numbers in the masked text are identical to the original. Parsers then run
//! simple scanners over the masked text without ever matching inside code.

/// Returns a copy of `text` with code and comments blanked out.
pub fn mask(text: &str) -> String {
    let mut out: Vec<u8> = text.as_bytes().to_vec();
    mask_fences(text, &mut out);
    // Inline code and comments are found on the fence-masked text so that
    // backticks/percent signs inside fences don't confuse them.
    let after_fences = bytes_to_string(&out);
    mask_inline_code(&after_fences, &mut out);
    let after_code = bytes_to_string(&out);
    mask_comments(&after_code, &mut out);
    bytes_to_string(&out)
}

/// Returns `text` with only `%% comments %%` blanked (code is kept, so it stays
/// searchable). Comment markers inside code are not treated as comments.
pub fn strip_comments(text: &str) -> String {
    let mut code_masked: Vec<u8> = text.as_bytes().to_vec();
    mask_fences(text, &mut code_masked);
    let after_fences = bytes_to_string(&code_masked);
    mask_inline_code(&after_fences, &mut code_masked);
    let code_masked = bytes_to_string(&code_masked);
    let mut out = text.as_bytes().to_vec();
    mask_comments(&code_masked, &mut out);
    bytes_to_string(&out)
}

fn bytes_to_string(b: &[u8]) -> String {
    // We only ever replace whole UTF-8 sequences with ASCII spaces, so this is valid.
    String::from_utf8(b.to_vec()).expect("masking keeps UTF-8 valid")
}

fn blank(out: &mut [u8], start: usize, end: usize) {
    let mut i = start;
    while i < end {
        if out[i] != b'\n' && out[i] != b'\r' {
            out[i] = b' ';
        }
        i += 1;
    }
}

/// Fenced blocks: a line starting (after ≤ 3 spaces) with ``` or ~~~ opens a block
/// that ends at a line with the same fence char repeated at least as many times.
/// An unclosed fence runs to the end of the file (CommonMark behaviour).
fn mask_fences(text: &str, out: &mut [u8]) {
    let mut open: Option<(u8, usize, usize)> = None; // (char, len, start offset)
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_start_matches(' ');
        let indent = line.len() - trimmed.len();
        let fence_char = trimmed.as_bytes().first().copied();
        let run = |c: u8| trimmed.bytes().take_while(|&b| b == c).count();
        match open {
            None => {
                if indent <= 3 && matches!(fence_char, Some(b'`') | Some(b'~')) {
                    let c = fence_char.unwrap();
                    let n = run(c);
                    // A backtick fence's info string may not contain backticks.
                    let info_ok = c != b'`' || !trimmed[n..].contains('`');
                    if n >= 3 && info_ok {
                        open = Some((c, n, offset));
                    }
                }
            }
            Some((c, n, start)) => {
                if indent <= 3 && fence_char == Some(c) && run(c) >= n && trimmed[run(c)..].trim().is_empty()
                {
                    blank(out, start, offset + line.len());
                    open = None;
                }
            }
        }
        offset += line.len();
    }
    if let Some((_, _, start)) = open {
        blank(out, start, text.len());
    }
}

/// Inline code: a run of N backticks closed by the next run of exactly N backticks.
fn mask_inline_code(text: &str, out: &mut [u8]) {
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'`' {
            let n = b[i..].iter().take_while(|&&c| c == b'`').count();
            let mut j = i + n;
            let mut closed = None;
            while j < b.len() {
                if b[j] == b'`' {
                    let m = b[j..].iter().take_while(|&&c| c == b'`').count();
                    if m == n {
                        closed = Some(j + m);
                        break;
                    }
                    j += m;
                } else {
                    j += 1;
                }
            }
            match closed {
                Some(end) => {
                    blank(out, i, end);
                    i = end;
                }
                None => i += n,
            }
        } else {
            i += 1;
        }
    }
}

/// `%% … %%` comments, inline or spanning lines. Unclosed `%%` is left as text.
fn mask_comments(text: &str, out: &mut [u8]) {
    let mut search = 0;
    while let Some(rel) = text[search..].find("%%") {
        let start = search + rel;
        match text[start + 2..].find("%%") {
            Some(rel_end) => {
                let end = start + 2 + rel_end + 2;
                blank(out, start, end);
                search = end;
            }
            None => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_length_and_newlines() {
        let t = "a `[[x]]` b\n```\n[[y]]\n```\n%% [[z]] %%\nend";
        let m = mask(t);
        assert_eq!(m.len(), t.len());
        assert_eq!(m.matches('\n').count(), t.matches('\n').count());
        assert!(!m.contains("[[x]]"));
        assert!(!m.contains("[[y]]"));
        assert!(!m.contains("[[z]]"));
        assert!(m.starts_with("a "));
        assert!(m.ends_with("end"));
    }

    #[test]
    fn tilde_fence_and_longer_close() {
        let t = "~~~~\n[[a]]\n~~~~~\n[[b]]";
        let m = mask(t);
        assert!(!m.contains("[[a]]"));
        assert!(m.contains("[[b]]"));
    }

    #[test]
    fn unclosed_fence_masks_to_end() {
        let m = mask("x\n```\n[[a]]\n");
        assert!(!m.contains("[[a]]"));
    }

    #[test]
    fn double_backtick_span() {
        let m = mask("``a ` [[x]]`` [[y]]");
        assert!(!m.contains("[[x]]"));
        assert!(m.contains("[[y]]"));
    }

    #[test]
    fn unicode_inside_code_stays_valid() {
        let m = mask("`héllo 🚀` [[ok]]");
        assert!(m.contains("[[ok]]"));
    }

    #[test]
    fn unclosed_comment_is_text() {
        let m = mask("50%% done [[a]]");
        assert!(m.contains("[[a]]"));
    }
}
