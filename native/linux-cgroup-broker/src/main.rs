use std::path::Path;

fn main() {
    let mut args = std::env::args_os().skip(1);
    let path = args.next().unwrap_or_else(|| "/sys/fs/cgroup".into());
    if args.next().is_some() {
        eprintln!("usage: infinyx-cgroup-preflight [cgroup-directory]");
        std::process::exit(2);
    }

    match infinyx_linux_cgroup_broker_protocol::preflight::inspect(Path::new(&path)) {
        Ok(report) => {
            println!("{}", serde_json::to_string_pretty(&report).expect("serialize preflight report"));
            if !report.cgroup2_filesystem {
                std::process::exit(1);
            }
        }
        Err(error) => {
            eprintln!("cgroup preflight failed: {error}");
            std::process::exit(1);
        }
    }
}
