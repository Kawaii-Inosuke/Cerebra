use std::path::Path;

use assert_cmd::Command;

fn library() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let r = d.path();
    std::fs::create_dir_all(r.join("Biology")).unwrap();
    std::fs::create_dir_all(r.join("Physics")).unwrap();
    std::fs::write(r.join("Biology/a.md"), "[[b]]").unwrap();
    std::fs::write(r.join("Biology/b.md"), "x").unwrap();
    std::fs::write(r.join("Physics/c.md"), "y").unwrap();
    std::fs::write(r.join("Quick.md"), "z").unwrap();
    d
}

fn cerebra(lib: &Path, args: &[&str]) -> String {
    let out = Command::cargo_bin("cerebra")
        .unwrap()
        .arg(lib)
        .args(args)
        .assert()
        .success();
    String::from_utf8(out.get_output().stdout.clone()).unwrap()
}

#[test]
fn info_lists_collections() {
    let d = library();
    let out = cerebra(d.path(), &["info"]);
    assert!(out.contains("Biology (2)"), "{out}");
    assert!(out.contains("Physics (1)"), "{out}");
    assert!(out.contains("notes: 4"), "{out}");
}

#[test]
fn upload_then_search_finds_text() {
    let d = library();
    let file = d.path().join("notes.txt");
    std::fs::write(&file, "mitochondria energy").unwrap();
    cerebra(d.path(), &["upload", "Biology", file.to_str().unwrap()]);
    std::fs::remove_file(&file).unwrap();
    let out = cerebra(d.path(), &["search", "mitochondria"]);
    assert!(out.contains("Biology/notes.md"), "{out}");
}

#[test]
fn search_can_be_limited_to_a_collection() {
    let d = library();
    std::fs::write(d.path().join("Physics/energy.md"), "energy and work").unwrap();
    std::fs::write(d.path().join("Biology/energy.md"), "energy in cells").unwrap();
    let out = cerebra(d.path(), &["search", "energy", "--collection", "Physics"]);
    assert!(out.contains("Physics/energy.md"), "{out}");
    assert!(!out.contains("Biology/"), "{out}");
}

#[test]
fn unknown_note_is_an_error() {
    let d = library();
    Command::cargo_bin("cerebra")
        .unwrap()
        .arg(d.path())
        .args(["backlinks", "Nope"])
        .assert()
        .failure();
}

#[test]
fn mcp_over_stdio() {
    let d = library();
    let input = concat!(
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"test"}}}"#,
        "\n",
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_collections","arguments":{}}}"#,
        "\n"
    );
    let out = Command::cargo_bin("cerebra")
        .unwrap()
        .arg(d.path())
        .args(["mcp", "--agent"])
        .write_stdin(input)
        .assert()
        .success();
    let text = String::from_utf8(out.get_output().stdout.clone()).unwrap();
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 2, "{text}");
    assert!(lines[0].contains("\"cerebra\""));
    assert!(lines[1].contains("Biology"), "{}", lines[1]);
}

#[test]
fn export_then_import_share_in_another_library() {
    let d = library();
    let other = tempfile::tempdir().unwrap();
    let file = other.path().join("Biology.cerebra");
    cerebra(d.path(), &["export", "Biology", file.to_str().unwrap()]);
    let out = cerebra(other.path(), &["import-share", file.to_str().unwrap()]);
    assert!(out.contains("\"collection\": \"Biology\""), "{out}");
    assert!(other.path().join("Biology/a.md").is_file());
}
