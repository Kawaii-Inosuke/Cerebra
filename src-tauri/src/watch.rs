//! Watches the open library and tells the app when notes change on disk (edits in
//! Obsidian or any editor, files copied in). Cerebra's own `.cerebra/` folder and other
//! hidden folders are ignored so the index writing itself can't trigger a reload loop.

use std::path::{Component, Path};
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_mini::{DebounceEventResult, Debouncer, new_debouncer};

/// Does a change at `path` matter for the library at `root`?
pub fn relevant(root: &Path, path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return false;
    };
    rel.components().all(|c| match c {
        Component::Normal(n) => !cerebra_core::vault::is_ignored_dir(&n.to_string_lossy()),
        _ => false,
    })
}

/// Start watching `root`; `on_change` runs (on the watcher's thread) at most every 500 ms.
/// Keep the returned value alive; dropping it stops the watch.
pub fn start(
    root: &Path,
    on_change: impl Fn() + Send + 'static,
) -> Result<Debouncer<notify::RecommendedWatcher>, String> {
    let owned = root.to_path_buf();
    let mut debouncer = new_debouncer(Duration::from_millis(500), move |res: DebounceEventResult| {
        if let Ok(events) = res
            && events.iter().any(|e| relevant(&owned, &e.path))
        {
            on_change();
        }
    })
    .map_err(|e| e.to_string())?;
    debouncer
        .watcher()
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    Ok(debouncer)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    #[test]
    fn watch_ignores_cerebra_folder() {
        let root = Path::new("/lib");
        assert!(relevant(root, Path::new("/lib/Biology/Cells.md")));
        assert!(relevant(root, Path::new("/lib/Biology/Files/unit3.pdf")));
        assert!(!relevant(root, Path::new("/lib/.cerebra/index.db")));
        assert!(!relevant(root, Path::new("/lib/.obsidian/workspace.json")));
        assert!(!relevant(root, Path::new("/lib/Biology/.DS_Store")));
        assert!(!relevant(root, Path::new("/lib/node_modules/x.md")));
        assert!(!relevant(root, Path::new("/elsewhere/x.md")));
    }
}
