// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // `Cerebra mcp …`: started by an AI app or by Cerebra's agents. No window.
    if args.get(1).map(String::as_str) == Some("mcp") {
        if let Err(e) = cerebra_app_lib::run_mcp(&args[2..]) {
            eprintln!("Cerebra: {e}");
            std::process::exit(1);
        }
        return;
    }
    cerebra_app_lib::run()
}
