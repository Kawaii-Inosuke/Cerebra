//! Black-box compatibility tests. For each fixture vault in `fixtures/libraries/compat`
//! that has an `expected.json` (recorded from Obsidian's UI, see RECORDING.md), the
//! engine's links, backlinks, unresolved links and tags must match exactly.
//! Fixtures without `expected.json` are reported as "not recorded yet" and skipped.

use std::collections::BTreeMap;
use std::path::Path;

use cerebra_core::{LinkIndex, Vault};
use serde_json::Value;

fn report(vault: &Vault) -> BTreeMap<String, Value> {
    let idx = LinkIndex::build(vault);
    vault
        .notes
        .iter()
        .map(|n| {
            let outgoing: Vec<String> = idx
                .resolved
                .get(&n.path)
                .map(|m| m.keys().cloned().collect())
                .unwrap_or_default();
            let backlinks: Vec<&str> = idx.backlinks(&n.path).keys().copied().collect();
            let unresolved: Vec<String> = idx
                .unresolved
                .get(&n.path)
                .map(|m| m.keys().cloned().collect())
                .unwrap_or_default();
            (
                n.path.clone(),
                serde_json::json!({
                    "outgoing": outgoing, "backlinks": backlinks,
                    "unresolved": unresolved, "tags": n.meta.tags,
                }),
            )
        })
        .collect()
}

fn sorted(v: &Value) -> Vec<String> {
    let mut out: Vec<String> = v
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    out.sort();
    out
}

#[test]
fn compat_fixtures_match_recorded_obsidian_behaviour() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/libraries/compat");
    let mut failures = Vec::new();
    let mut recorded = 0;
    let mut dirs: Vec<_> = std::fs::read_dir(&root)
        .unwrap()
        .flatten()
        .filter(|e| e.path().is_dir())
        .collect();
    dirs.sort_by_key(|e| e.file_name());
    for dir in dirs {
        let name = dir.file_name().to_string_lossy().into_owned();
        let expected_path = dir.path().join("expected.json");
        let vault = Vault::load(dir.path()).unwrap();
        let actual = report(&vault);
        if !expected_path.exists() {
            eprintln!("[compat] {name}: not recorded yet (no expected.json), skipped");
            continue;
        }
        recorded += 1;
        let expected: BTreeMap<String, Value> =
            serde_json::from_str(&std::fs::read_to_string(&expected_path).unwrap()).unwrap();
        for (note, exp) in &expected {
            let Some(act) = actual.get(note) else {
                failures.push(format!("{name}/{note}: note missing from engine output"));
                continue;
            };
            for field in ["outgoing", "backlinks", "unresolved", "tags"] {
                let (e, a) = (sorted(&exp[field]), sorted(&act[field]));
                if e != a {
                    failures.push(format!("{name}/{note} {field}: obsidian={e:?} engine={a:?}"));
                }
            }
        }
    }
    eprintln!("[compat] {recorded} fixture(s) compared");
    assert!(failures.is_empty(), "compat mismatches:\n{}", failures.join("\n"));
}
