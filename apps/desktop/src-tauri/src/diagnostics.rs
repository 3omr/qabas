//! Bounded, redacted diagnostic export for user-initiated support bundles.

use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
const REDACTED: &str = "<redacted>";

/// Collect product/runtime metadata and the bounded tail of each desktop log.
///
/// Configuration, credentials, sessions, and user files are deliberately not
/// included. The resulting text receives a second redaction pass immediately
/// before it is returned to the save callback.
pub fn collect(app: &AppHandle) -> Result<String, String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|error| error.to_string())?;
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let home = app.path().home_dir().ok();
    let mut output = String::new();
    output.push_str("Qabas diagnostics\n");
    output.push_str(&format!("appVersion: {}\n", app.package_info().version));
    output.push_str(&format!("platform: {}\n", std::env::consts::OS));
    output.push_str(&format!("arch: {}\n", std::env::consts::ARCH));
    output.push_str(&format!("generatedAtUnix: {}\n", unix_seconds()));

    let runtime_manifest = resource_dir.join("runtime/runtime-manifest.json");
    if let Ok(manifest) = fs::read_to_string(runtime_manifest) {
        output.push_str("\n[runtime-manifest]\n");
        output.push_str(&manifest);
        if !manifest.ends_with('\n') {
            output.push('\n');
        }
    }

    let mut logs = log_files(&log_dir)?;
    logs.sort();
    for path in logs {
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("desktop.log");
        output.push_str(&format!("\n[log:{name}]\n"));
        match read_tail(&path, MAX_LOG_BYTES) {
            Ok(log) => output.push_str(&log),
            Err(error) => output.push_str(&format!("<could not read log: {error}>\n")),
        }
    }

    Ok(redact(&output, home.as_deref()))
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn log_files(log_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let entries = match fs::read_dir(log_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    Ok(entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .filter(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("log"))
        })
        .collect())
}

fn read_tail(path: &Path, limit: u64) -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let len = file.metadata().map_err(|error| error.to_string())?.len();
    let start = len.saturating_sub(limit);
    file.seek(SeekFrom::Start(start))
        .map_err(|error| error.to_string())?;
    let mut bytes = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if start > 0 {
        if let Some(newline) = text.find('\n') {
            text.drain(..=newline);
        }
        text.insert_str(0, "<earlier log content omitted>\n");
    }
    if !text.ends_with('\n') {
        text.push('\n');
    }
    Ok(text)
}

pub(crate) fn redact(input: &str, home: Option<&Path>) -> String {
    let mut output = input.to_owned();
    if let Some(home) = home.and_then(Path::to_str) {
        if !home.is_empty() {
            output = output.replace(home, "<HOME>");
        }
    }
    for marker in [
        "x-dsh-desktop-token:",
        "x-dsh-desktop-bridge-token:",
        "DSH_DESKTOP_AUTH_TOKEN=",
        "DSH_DESKTOP_BRIDGE_TOKEN=",
        "Authorization: Bearer ",
        "authorization: Bearer ",
        "dsh-auth.",
        "\"apiKey\":\"",
        "\"api_key\":\"",
        "\"token\":\"",
        "?token=",
        "&token=",
    ] {
        output = redact_after_marker(&output, marker);
    }
    output
}

fn redact_after_marker(input: &str, marker: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut remaining = input;
    while let Some(index) = remaining.find(marker) {
        let value_start = index + marker.len();
        output.push_str(&remaining[..value_start]);
        let tail = &remaining[value_start..];
        let padding = tail
            .find(|character: char| !character.is_whitespace())
            .unwrap_or(tail.len());
        output.push_str(&tail[..padding]);
        if padding == tail.len() {
            remaining = "";
            break;
        }
        output.push_str(REDACTED);
        let value = &tail[padding..];
        let value_end = value
            .find(|character: char| {
                character.is_whitespace()
                    || matches!(character, '"' | '\'' | ',' | ';' | ']' | '}' | ')')
            })
            .unwrap_or(value.len());
        remaining = &value[value_end..];
    }
    output.push_str(remaining);
    output
}

#[cfg(test)]
mod tests {
    use super::{read_tail, redact};
    use std::{fs, path::Path};

    #[test]
    fn removes_desktop_tokens_credentials_and_home_paths() {
        let input = concat!(
            "x-dsh-desktop-token: web-secret\n",
            "x-dsh-desktop-bridge-token: bridge-secret\n",
            "Sec-WebSocket-Protocol: dsh-auth.ws-secret\n",
            "Authorization: Bearer provider-secret\n",
            "config={\"apiKey\":\"api-secret\",\"token\":\"token-secret\"}\n",
            "dsh web: http://127.0.0.1:43123/?token=launch-secret\n",
            "/Users/alice/project\n",
        );
        let redacted = redact(input, Some(Path::new("/Users/alice")));
        for secret in [
            "web-secret",
            "bridge-secret",
            "ws-secret",
            "provider-secret",
            "api-secret",
            "token-secret",
            "launch-secret",
            "/Users/alice",
        ] {
            assert!(!redacted.contains(secret), "secret survived: {secret}");
        }
        assert!(redacted.contains("dsh-auth.<redacted>"));
        assert!(redacted.contains("<HOME>/project"));
    }

    #[test]
    fn bounds_exported_log_tail() {
        let path = std::env::temp_dir().join(format!(
            "dsh-diagnostics-{}-{}.log",
            std::process::id(),
            super::unix_seconds(),
        ));
        fs::write(&path, "old line\nkeep line\nlast line\n").expect("write fixture");
        let tail = read_tail(&path, 21).expect("read tail");
        fs::remove_file(path).expect("remove fixture");
        assert!(tail.starts_with("<earlier log content omitted>\n"));
        assert!(!tail.contains("old line"));
        assert!(tail.contains("last line"));
    }
}
