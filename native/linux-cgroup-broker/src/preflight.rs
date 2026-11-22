//! Read-only cgroup v2 host inspection. This module never creates or writes cgroups.

use serde::Serialize;
use std::ffi::CString;
use std::fs;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

const CGROUP2_SUPER_MAGIC: libc::c_long = 0x6367_7270;

#[derive(Debug, Clone, Serialize)]
pub struct PreflightReport {
    pub inspected_path: PathBuf,
    pub cgroup2_filesystem: bool,
    pub controllers: Vec<String>,
    pub subtree_control: Vec<String>,
    pub populated: Option<bool>,
    pub has_cgroup_procs: bool,
    pub has_cgroup_kill: bool,
    pub can_read_events: bool,
    pub effective_write_access: EffectiveWriteAccess,
    /// Always false: filesystem inspection cannot prove the full security boundary.
    pub broker_activation_eligible: bool,
    pub limitations: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EffectiveWriteAccess {
    pub subtree_control: bool,
    pub cgroup_procs: bool,
    pub cgroup_kill: bool,
}

pub fn inspect(path: &Path) -> io::Result<PreflightReport> {
    let canonical = fs::canonicalize(path)?;
    if !canonical.is_dir() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "cgroup path is not a directory"));
    }

    let cgroup2_filesystem = is_cgroup2_filesystem(&canonical)?;
    let controllers = read_words(&canonical.join("cgroup.controllers")).unwrap_or_default();
    let subtree_control = read_words(&canonical.join("cgroup.subtree_control")).unwrap_or_default();
    let events = fs::read_to_string(canonical.join("cgroup.events")).ok();
    let populated = events.as_deref().and_then(parse_populated);

    let report = PreflightReport {
        inspected_path: canonical.clone(),
        cgroup2_filesystem,
        controllers,
        subtree_control,
        populated,
        has_cgroup_procs: canonical.join("cgroup.procs").is_file(),
        has_cgroup_kill: canonical.join("cgroup.kill").is_file(),
        can_read_events: events.is_some(),
        effective_write_access: EffectiveWriteAccess {
            subtree_control: effective_access(&canonical.join("cgroup.subtree_control"), libc::W_OK),
            cgroup_procs: effective_access(&canonical.join("cgroup.procs"), libc::W_OK),
            cgroup_kill: effective_access(&canonical.join("cgroup.kill"), libc::W_OK),
        },
        broker_activation_eligible: false,
        limitations: vec![
            "Read-only inspection only; no cgroup or process was created or modified.".into(),
            "Write-access checks do not prove that a child subtree can be delegated safely.".into(),
            "This does not verify application/evaluator UID separation or migration resistance.".into(),
            "This does not launch, terminate, or prove emptiness of any process tree.".into(),
            "Broker activation requires separate privileged integration tests on the target host.".into(),
        ],
    };
    Ok(report)
}

fn is_cgroup2_filesystem(path: &Path) -> io::Result<bool> {
    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains a NUL byte"))?;
    let mut stats = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: statfs writes the statfs structure for a valid NUL-terminated path.
    let result = unsafe { libc::statfs(path.as_ptr(), stats.as_mut_ptr()) };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful statfs initialized the complete structure.
    let stats = unsafe { stats.assume_init() };
    Ok(stats.f_type as libc::c_long == CGROUP2_SUPER_MAGIC)
}

fn read_words(path: &Path) -> io::Result<Vec<String>> {
    let value = fs::read_to_string(path)?;
    Ok(value.split_whitespace().map(str::to_owned).collect())
}

fn effective_access(path: &Path, mode: libc::c_int) -> bool {
    let Ok(path) = CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: path is NUL-terminated and AT_EACCESS asks the kernel to check
    // effective credentials; this performs an access check, not a write.
    unsafe { libc::faccessat(libc::AT_FDCWD, path.as_ptr(), mode, libc::AT_EACCESS) == 0 }
}

fn parse_populated(events: &str) -> Option<bool> {
    events.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        if parts.next()? != "populated" {
            return None;
        }
        match parts.next()? {
            "0" => Some(false),
            "1" => Some(true),
            _ => None,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_populated_state_without_treating_missing_as_empty() {
        assert_eq!(parse_populated("populated 0\nfrozen 0\n"), Some(false));
        assert_eq!(parse_populated("populated 1\nfrozen 0\n"), Some(true));
        assert_eq!(parse_populated("frozen 0\n"), None);
        assert_eq!(parse_populated("populated unknown\n"), None);
    }

    #[test]
    fn report_is_never_broker_activation_eligible() {
        let report = PreflightReport {
            inspected_path: PathBuf::from("/sys/fs/cgroup"),
            cgroup2_filesystem: true,
            controllers: vec!["cpu".into()],
            subtree_control: vec![],
            populated: Some(false),
            has_cgroup_procs: true,
            has_cgroup_kill: true,
            can_read_events: true,
            effective_write_access: EffectiveWriteAccess {
                subtree_control: true,
                cgroup_procs: true,
                cgroup_kill: true,
            },
            broker_activation_eligible: false,
            limitations: vec![],
        };
        assert!(!report.broker_activation_eligible);
    }
}
