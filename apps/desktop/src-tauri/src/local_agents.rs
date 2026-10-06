//! User-initiated CLI preflight; installation and account state are not Harness activation.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::Duration,
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Default)]
pub(crate) struct AgentChecks(Mutex<()>);

#[derive(Clone)]
pub(crate) struct IntegrationPaths {
    pub codex: PathBuf,
    pub claude: PathBuf,
    pub acp: PathBuf,
    pub preset: PathBuf,
}

/// Build-owned metadata resolves package dependencies; native preflight never searches PATH for SDK agents.
#[derive(Clone)]
pub(crate) struct ProbePaths {
    pub root: PathBuf,
    pub manifest: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProbeManifest {
    schema_version: u32,
    codex_wrapper: PathBuf,
    claude_executable: PathBuf,
}

impl ProbePaths {
    fn executable(&self, id: &str) -> Result<PathBuf, String> {
        let metadata =
            std::fs::symlink_metadata(&self.manifest).map_err(|_| "probe-manifest-unavailable")?;
        if !metadata.is_file() || metadata.len() > 65536 {
            return Err("invalid-probe-manifest".into());
        }
        let manifest: ProbeManifest = serde_json::from_slice(
            &std::fs::read(&self.manifest).map_err(|_| "probe-manifest-unavailable")?,
        )
        .map_err(|_| "invalid-probe-manifest")?;
        if manifest.schema_version != 1 {
            return Err("invalid-probe-manifest".into());
        }
        let relative = match id {
            "codex" => manifest.codex_wrapper,
            "claude" => manifest.claude_executable,
            _ => return Err("unknown-agent".into()),
        };
        if relative.as_os_str().is_empty()
            || relative
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return Err("invalid-probe-path".into());
        }
        let root = self
            .root
            .canonicalize()
            .map_err(|_| "runtime-unavailable")?;
        let file = root
            .join(relative)
            .canonicalize()
            .map_err(|_| "agent-runtime-unavailable")?;
        if !file.starts_with(root) || !file.is_file() {
            return Err("invalid-probe-path".into());
        }
        Ok(file)
    }
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(transparent)]
pub(crate) struct AgentPreferences(BTreeMap<String, bool>);

impl AgentPreferences {
    fn enabled(&self, id: &str) -> bool {
        self.0.get(id).copied().unwrap_or(false)
    }

    fn validate(&self) -> Result<(), String> {
        let entries = catalog();
        if self
            .0
            .keys()
            .any(|id| !entries.iter().any(|entry| &entry.id == id))
        {
            return Err("unknown-agent".into());
        }
        Ok(())
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct AgentDefinition {
    id: String,
    name: String,
    command: String,
    transport: String,
    provider: String,
    tool: String,
    args: Vec<String>,
    login: String,
    docs: String,
    summary: BTreeMap<String, String>,
    source: String,
}

fn catalog() -> Vec<AgentDefinition> {
    serde_json::from_str(include_str!("../../loading/agents.json")).expect("packaged agent catalog")
}

/// Public metadata only; executable choices remain owned by the packaged catalog.
#[tauri::command]
pub(crate) fn desktop_agent_catalog() -> Vec<AgentDefinition> {
    catalog()
}

fn preferences(home: &Path) -> Result<AgentPreferences, String> {
    let path = home.join("desktop-agents.json");
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) if !metadata.is_file() || metadata.len() > 4096 => {
            return Err("invalid-preferences-file".into())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AgentPreferences::default())
        }
        Err(_) => return Err("preferences-unreadable".into()),
        _ => {}
    }
    let value: AgentPreferences =
        serde_json::from_slice(&std::fs::read(path).map_err(|_| "preferences-unreadable")?)
            .map_err(|_| "invalid-preferences")?;
    value.validate()?;
    Ok(value)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let directory = path.parent().ok_or("invalid-output-path")?;
    std::fs::create_dir_all(directory).map_err(|_| "directory-unwritable")?;
    let mut temp = tempfile::NamedTempFile::new_in(directory).map_err(|_| "file-unwritable")?;
    temp.write_all(bytes)
        .and_then(|()| temp.as_file().sync_all())
        .map_err(|_| "file-unwritable")?;
    temp.persist(path).map_err(|_| "file-unwritable")?;
    Ok(())
}

/// Read or atomically save opt-ins. Saving never interrupts a running session or logs credentials.
#[tauri::command]
pub(crate) fn desktop_agent_preferences(
    window: tauri::WebviewWindow,
    value: Option<AgentPreferences>,
) -> Result<AgentPreferences, String> {
    if window.label() != "extensions"
        || !allowed_document(&window.url().map_err(|_| "invalid-window")?)
    {
        return Err("local-document-required".into());
    }
    let home = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|_| "home-unavailable")?
        .join("harness");
    let state = window.state::<AgentChecks>();
    let _guard = state.0.try_lock().map_err(|_| "check-in-progress")?;
    if let Some(value) = value {
        let paths = super::runtime_paths(window.app_handle())
            .map_err(|_| "runtime-unavailable")?
            .integrations;
        validate_providers(&paths, &value)?;
        let user_home = window
            .app_handle()
            .path()
            .home_dir()
            .map_err(|_| "home-unavailable")?;
        let directories = search_directories(std::env::var_os("PATH"), &user_home);
        for entry in catalog()
            .iter()
            .filter(|entry| entry.transport == "acp" && value.enabled(&entry.id))
        {
            acp_executable(entry, &directories)?;
        }
        let _ = preferences(&home)?;
        atomic_write(
            &home.join("desktop-agents.json"),
            &serde_json::to_vec(&value).map_err(|_| "invalid-preferences")?,
        )?;
        Ok(value)
    } else {
        preferences(&home)
    }
}

fn validate_providers(paths: &IntegrationPaths, value: &AgentPreferences) -> Result<(), String> {
    value.validate()?;
    if (value.enabled("codex") && !paths.codex.is_file())
        || (value.enabled("claude") && !paths.claude.is_file())
        || (catalog()
            .iter()
            .any(|entry| entry.transport == "acp" && value.enabled(&entry.id))
            && !paths.acp.is_file())
    {
        return Err("provider-not-bundled".into());
    }
    Ok(())
}

/// Add opt-in providers and a separate app-owned preset without changing standard or user-authored presets.
pub(crate) fn materialize(home: &Path, paths: &IntegrationPaths) -> Result<String, String> {
    let user_home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .ok_or("home-unavailable")?;
    let directories = search_directories(std::env::var_os("PATH"), &PathBuf::from(user_home));
    materialize_with_directories(home, paths, &directories)
}

fn materialize_with_directories(
    home: &Path,
    paths: &IntegrationPaths,
    directories: &[PathBuf],
) -> Result<String, String> {
    let value = preferences(home)?;
    validate_providers(paths, &value)?;
    let source =
        std::fs::read_to_string(&paths.preset).map_err(|_| "standard-preset-unavailable")?;
    let preset = render_preset(&source, &value)?;
    let root = home.join("desktop-presets");
    let directory = root.join("desktop-local-agents");
    atomic_write(&directory.join("agent.cordis.yml"), preset.as_bytes())?;
    let metadata = serde_json::json!({ "name": super::locale::text("Local agents", "本地代理"), "description": super::locale::text("Standard tools with desktop-selected agent delegation.", "标准工具与桌面端选用的子代理。"), "order": 2 });
    atomic_write(
        &directory.join("preset.yml"),
        metadata.to_string().as_bytes(),
    )?;
    let mut rows = vec![
        serde_json::json!({ "id": "agent-presets", "config": { "default": "standard", "roots": [{ "path": root, "trust": "system" }] } }),
    ];
    let mut providers = Vec::new();
    for (enabled, id, path) in [
        (value.enabled("codex"), "subagent-codex", &paths.codex),
        (
            value.enabled("claude"),
            "subagent-claude-code",
            &paths.claude,
        ),
    ] {
        if enabled {
            let path = path.canonicalize().map_err(|_| "provider-not-bundled")?;
            let url = url::Url::from_file_path(path).map_err(|_| "invalid-provider-path")?;
            providers.push(serde_json::json!({ "id": id, "name": url.as_str() }));
        }
    }
    for entry in catalog()
        .iter()
        .filter(|entry| entry.transport == "acp" && value.enabled(&entry.id))
    {
        let executable = acp_executable(entry, directories)?;
        let module = url::Url::from_file_path(&paths.acp).map_err(|_| "invalid-provider-path")?;
        let path = std::env::join_paths(directories).map_err(|_| "invalid-search-path")?;
        providers.push(
            serde_json::json!({"id": entry.provider, "name": module.as_str(), "config": {
                "providerName": entry.provider, "command": executable, "args": entry.args,
                "permission": "reject", "env": {"PATH": path.to_string_lossy()}
            }}),
        );
    }
    if !providers.is_empty() {
        rows.push(serde_json::json!({ "insert": providers }));
    }
    // JSON objects are YAML flow mappings; keep the existing desktop patch as its own sequence.
    Ok(rows.iter().map(|row| format!("\n- {row}\n")).collect())
}

fn acp_executable(entry: &AgentDefinition, directories: &[PathBuf]) -> Result<PathBuf, String> {
    let path = executable(&entry.command, directories)
        .ok_or_else(|| format!("agent-not-installed:{}", entry.id))?;
    if path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("cmd"))
    {
        return Err(format!("agent-shim-unsupported:{}", entry.id));
    }
    Ok(path)
}

fn render_preset(source: &str, preferences: &AgentPreferences) -> Result<String, String> {
    let mut output = source.to_owned();
    for (id, enabled) in [
        ("tool-subagent-codex", preferences.enabled("codex")),
        ("tool-subagent-claude-code", preferences.enabled("claude")),
    ] {
        let needle = format!(
            "    - id: {id}\n      name: '@deepseek-ai/dsh-tool-subagent'\n      disabled: true\n"
        );
        if output.matches(&needle).count() != 1 {
            return Err("unsupported-standard-preset".into());
        }
        if enabled {
            output = output.replace(&needle, &needle.replace("      disabled: true\n", ""));
        }
    }
    for entry in catalog()
        .iter()
        .filter(|entry| entry.transport == "acp" && preferences.enabled(&entry.id))
    {
        let row = serde_json::json!({"id": format!("tool-{}", entry.provider), "name": "@deepseek-ai/dsh-tool-subagent", "config": {
            "provider": entry.provider, "toolName": entry.tool, "backgroundMode": "one-shot", "maxDepth": "provider-managed"
        }});
        output.push_str(&format!("\n- {row}\n"));
    }
    Ok(output)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentStatus {
    id: String,
    executable: Option<String>,
    version: Option<String>,
    state: &'static str,
    auth: &'static str,
    runtime_source: &'static str,
}

/// Open one local-only extension document; no runtime navigation or restart is required.
pub(crate) fn show(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("extensions") {
        window.unminimize()?;
        window.show()?;
        return window.set_focus();
    }
    WebviewWindowBuilder::new(app, "extensions", WebviewUrl::App("extensions.html".into()))
        .title(super::locale::text(
            "Extensions · Qabas",
            "扩展中心 · Qabas",
        ))
        .inner_size(740.0, 760.0)
        .min_inner_size(580.0, 520.0)
        .on_navigation(allowed_document)
        .build()?;
    Ok(())
}

/// Focus the Agents tab of an existing window without discarding either tab's draft.
pub(crate) fn show_agents(app: &tauri::AppHandle) -> tauri::Result<()> {
    let existing = app.get_webview_window("extensions");
    show(app)?;
    if let Some(window) = existing {
        window.eval(include_str!("../../loading/show-agents.js"))?;
    }
    Ok(())
}

pub(crate) fn allowed_document(url: &url::Url) -> bool {
    let origin = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"));
    origin
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/extensions.html"
        && url.query().is_none()
}

/// Inspect fixed CLI commands only. No caller-supplied program, arguments, or environment is accepted.
#[tauri::command]
pub(crate) async fn desktop_local_agents(
    window: tauri::WebviewWindow,
) -> Result<Vec<AgentStatus>, String> {
    if window.label() != "extensions"
        || !allowed_document(&window.url().map_err(|_| "invalid-window")?)
    {
        return Err("local-document-required".to_owned());
    }
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AgentChecks>();
        let _check = state
            .0
            .try_lock()
            .map_err(|_| "check-in-progress".to_owned())?;
        let home = app
            .path()
            .home_dir()
            .map_err(|_| "home-unavailable".to_owned())?;
        let directories = search_directories(std::env::var_os("PATH"), &home);
        let runtime = super::runtime_paths(&app).map_err(|_| "runtime-unavailable".to_owned())?;
        // The curated catalog bounds concurrency; opening the page never starts a probe.
        Ok(std::thread::scope(|scope| {
            let entries = catalog();
            let checks: Vec<_> = entries
                .into_iter()
                .map(|entry| {
                    let directories = &directories;
                    let home = &home;
                    let runtime = &runtime;
                    scope.spawn(move || {
                        if entry.transport == "sdk" {
                            inspect_bundled(
                                &entry.id,
                                directories,
                                home,
                                &runtime.node,
                                &runtime.agent_probes,
                            )
                        } else {
                            inspect(&entry.id, directories, home)
                        }
                    })
                })
                .collect();
            checks
                .into_iter()
                .map(|check| check.join().expect("Agent diagnostic thread"))
                .collect()
        }))
    })
    .await
    .map_err(|_| "check-failed".to_owned())?
}

pub(crate) fn search_directories(path: Option<OsString>, home: &Path) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = path
        .as_deref()
        .map(std::env::split_paths)
        .into_iter()
        .flatten()
        .filter(|path| path.is_absolute())
        .collect();
    paths.extend([
        home.join(".local/bin"),
        home.join(".npm-global/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    #[cfg(windows)]
    if let Some(appdata) = std::env::var_os("APPDATA") {
        paths.push(PathBuf::from(appdata).join("npm"));
    }
    #[cfg(windows)]
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        paths.push(PathBuf::from(profile).join(".local").join("bin"));
    }
    // Finder launches do not inherit a terminal's nvm PATH. Read directory names, never shell startup files.
    if let Ok(versions) = std::fs::read_dir(home.join(".nvm/versions/node")) {
        let mut versions: Vec<_> = versions
            .filter_map(Result::ok)
            .map(|entry| entry.path().join("bin"))
            .collect();
        versions.sort();
        paths.extend(versions.into_iter().rev().take(32));
    }
    paths
}

pub(crate) fn executable(id: &str, directories: &[PathBuf]) -> Option<PathBuf> {
    #[cfg(windows)]
    let names = [format!("{id}.exe"), format!("{id}.cmd")];
    #[cfg(not(windows))]
    let names = [id.to_owned()];
    directories
        .iter()
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .find(|path| {
            let Ok(metadata) = path.metadata() else {
                return false;
            };
            if !metadata.is_file() {
                return false;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                metadata.permissions().mode() & 0o111 != 0
            }
            #[cfg(not(unix))]
            {
                true
            }
        })
}

fn command(path: &Path, home: &Path, directories: &[PathBuf], args: &[&str]) -> Command {
    let mut command = Command::new(path);
    command.args(args).current_dir(home).env_clear();
    command.envs(safe_environment(directories));
    command
}

/// Build the scrubbed child environment shared by ordinary probes and native PTYs.
pub(crate) fn safe_environment(directories: &[PathBuf]) -> Vec<(OsString, OsString)> {
    let mut environment: Vec<_> = std::env::vars_os()
        .filter(|(key, _)| {
            let key = key.to_string_lossy();
            !key.eq_ignore_ascii_case("PATH")
                && !key.eq_ignore_ascii_case("NO_COLOR")
                && safe_environment_key(&key)
        })
        .collect();
    if let Ok(path) = std::env::join_paths(directories) {
        environment.push((OsString::from("PATH"), path));
    }
    environment.push((OsString::from("NO_COLOR"), OsString::from("1")));
    environment
}

fn safe_environment_key(key: &str) -> bool {
    let key = key.to_ascii_uppercase();
    !["KEY", "SECRET", "TOKEN", "PASSWORD"]
        .iter()
        .any(|part| key.contains(part))
        && ![
            "NODE_OPTIONS",
            "NODE_PATH",
            "LD_PRELOAD",
            "LD_LIBRARY_PATH",
            "DYLD_INSERT_LIBRARIES",
            "DYLD_LIBRARY_PATH",
        ]
        .contains(&key.as_str())
}

fn inspect(id: &str, directories: &[PathBuf], home: &Path) -> AgentStatus {
    let result = AgentStatus {
        id: id.to_owned(),
        executable: None,
        version: None,
        state: "missing",
        auth: "unchecked",
        runtime_source: "local-cli",
    };
    let Some(path) = executable(id, directories) else {
        return result;
    };
    inspect_executable(result, &path, &[], &path, directories, home)
}

fn inspect_bundled(
    id: &str,
    directories: &[PathBuf],
    home: &Path,
    node: &Path,
    probes: &ProbePaths,
) -> AgentStatus {
    let result = AgentStatus {
        id: id.to_owned(),
        executable: None,
        version: None,
        state: "unavailable",
        auth: "unchecked",
        runtime_source: "bundled",
    };
    let Ok(path) = probes.executable(id) else {
        return result;
    };
    if id == "codex" {
        inspect_executable(
            result,
            node,
            &[dunce::simplified(&path).as_os_str().to_owned()],
            &path,
            directories,
            home,
        )
    } else {
        inspect_executable(result, &path, &[], &path, directories, home)
    }
}

fn inspect_executable(
    mut result: AgentStatus,
    program: &Path,
    prefix: &[OsString],
    path: &Path,
    directories: &[PathBuf],
    home: &Path,
) -> AgentStatus {
    result.executable = Some(path.display().to_string());
    if path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("cmd"))
    {
        result.state = "manual-check";
        return result;
    }
    let make_command = |args: &[&str]| {
        let mut cmd = command(program, home, directories, &[]);
        cmd.args(prefix).args(args);
        cmd
    };
    let version = super::runtime::probe_command(make_command(&["--version"]), PROBE_TIMEOUT);
    let (code, stdout, _) = match version {
        Ok(output) => output,
        Err(error) => {
            result.state = if error == "probe-timeout" {
                "timeout"
            } else {
                "unavailable"
            };
            return result;
        }
    };
    if code != Some(0) {
        result.state = "unavailable";
        return result;
    }
    result.version = version_number(&stdout);
    if result.version.is_none() {
        result.state = "unrecognized";
        return result;
    }
    result.state = "runnable";
    let id = result.id.as_str();
    if id != "codex" && id != "claude" {
        result.auth = "manual-auth";
        return result;
    }
    let args: &[&str] = if id == "codex" {
        &["login", "status"]
    } else {
        &["auth", "status"]
    };
    result.auth = match super::runtime::probe_command(make_command(args), PROBE_TIMEOUT) {
        Ok((code, stdout, stderr)) => auth_state(id, code, &stdout, &stderr),
        Err(error) if error == "probe-timeout" => "timeout",
        Err(_) => "unknown",
    };
    result
}

fn version_number(output: &str) -> Option<String> {
    output
        .split_whitespace()
        .find(|word| {
            word.len() <= 48
                && word.as_bytes().first().is_some_and(u8::is_ascii_digit)
                && word.split('.').count() >= 3
                && word
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b".-+".contains(&byte))
        })
        .map(str::to_owned)
}

fn auth_state(id: &str, code: Option<i32>, stdout: &str, stderr: &str) -> &'static str {
    if id == "claude" {
        let value = serde_json::from_str::<serde_json::Value>(stdout).ok();
        return match (
            code,
            value
                .as_ref()
                .and_then(|value| value.get("loggedIn"))
                .and_then(serde_json::Value::as_bool),
        ) {
            (Some(0), Some(true)) => "authenticated",
            (Some(1), Some(false)) | (Some(0), Some(false)) => "signed-out",
            _ => "unknown",
        };
    }
    let lines = stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .collect::<Vec<_>>();
    if code == Some(0)
        && lines
            .iter()
            .any(|line| line.starts_with("Logged in using "))
    {
        "authenticated"
    } else if code == Some(1) && lines.contains(&"Not logged in") {
        "signed-out"
    } else {
        "unknown"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_metadata_rejects_unknown_versions_paths_and_missing_payloads() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("agent");
        std::fs::write(&file, "fixture").unwrap();
        let probes = ProbePaths {
            root: root.path().to_owned(),
            manifest: root.path().join("agent-runtimes.json"),
        };
        let record = |version: u32, path: &str| {
            std::fs::write(&probes.manifest, serde_json::json!({"schemaVersion":version,"codexWrapper":path,"claudeExecutable":"agent"}).to_string()).unwrap();
        };
        record(1, "agent");
        assert_eq!(
            probes.executable("codex").unwrap(),
            file.canonicalize().unwrap()
        );
        assert!(probes.executable("unknown").is_err());
        record(2, "agent");
        assert!(probes.executable("codex").is_err());
        for path in ["", "../agent", "/agent", "missing"] {
            record(1, path);
            assert!(probes.executable("codex").is_err());
        }
        std::fs::write(&probes.manifest, "x".repeat(65537)).unwrap();
        assert!(probes.executable("codex").is_err());
        std::fs::write(&probes.manifest, "{}").unwrap();
        assert!(probes.executable("codex").is_err());
        #[cfg(unix)]
        {
            let outside = tempfile::NamedTempFile::new().unwrap();
            std::os::unix::fs::symlink(outside.path(), root.path().join("outside-link")).unwrap();
            record(1, "outside-link");
            assert!(probes.executable("codex").is_err());
        }
    }

    #[test]
    #[cfg(unix)]
    fn bundled_checks_ignore_a_different_path_cli_and_never_fall_back() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let script = |name: &str, body: &str| {
            let path = root.path().join(name);
            std::fs::write(&path, body).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
            path
        };
        let node = script("node", "#!/bin/sh\ncase \"$2\" in --version) echo codex-cli 1.2.3;; login) echo 'Logged in using fixture';; *) exit 2;; esac\n");
        script("codex", "#!/bin/sh\necho codex-cli 9.9.9\n");
        let wrapper = script("wrapper.js", "not executable JavaScript");
        let probes = ProbePaths {
            root: root.path().to_owned(),
            manifest: root.path().join("agent-runtimes.json"),
        };
        std::fs::write(
            &probes.manifest,
            r#"{"schemaVersion":1,"codexWrapper":"wrapper.js","claudeExecutable":"claude"}"#,
        )
        .unwrap();
        let directories = vec![root.path().to_owned()];
        let local = inspect("codex", &directories, root.path());
        assert_eq!(local.version.as_deref(), Some("9.9.9"));
        let bundled = inspect_bundled("codex", &directories, root.path(), &node, &probes);
        assert_eq!(bundled.version.as_deref(), Some("1.2.3"));
        assert_eq!(bundled.auth, "authenticated");
        assert_eq!(bundled.runtime_source, "bundled");
        assert_eq!(
            bundled.executable,
            Some(wrapper.canonicalize().unwrap().display().to_string())
        );
        std::fs::remove_file(wrapper).unwrap();
        let missing = inspect_bundled("codex", &directories, root.path(), &node, &probes);
        assert_eq!(missing.state, "unavailable");
        assert!(missing.version.is_none());
        assert_eq!(missing.auth, "unchecked");
    }

    #[test]
    #[ignore = "Requires desktop:prepare; checks packaged versions only, never login or inference"]
    fn packaged_agent_versions_without_host_cli_or_user_credentials() {
        let runtime = dunce::canonicalize(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/runtime"),
        )
        .unwrap();
        let probes = ProbePaths {
            manifest: runtime.join("agent-runtimes.json"),
            root: runtime.clone(),
        };
        let home = tempfile::tempdir().unwrap();
        let node = runtime
            .join("node")
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        for id in ["codex", "claude"] {
            let path = probes.executable(id).unwrap();
            let mut command = Command::new(if id == "codex" { &node } else { &path });
            command.env_clear().current_dir(home.path());
            for key in ["SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP"] {
                if let Some(value) = std::env::var_os(key) {
                    command.env(key, value);
                }
            }
            command
                .env("HOME", home.path())
                .env("USERPROFILE", home.path())
                .env("CODEX_HOME", home.path().join("codex"))
                .env("CLAUDE_CONFIG_DIR", home.path().join("claude"))
                .env("PATH", node.parent().unwrap())
                .env("NO_COLOR", "1");
            if id == "codex" {
                command.arg(dunce::simplified(&path));
            }
            command.arg("--version");
            let (code, output, _) =
                super::super::runtime::probe_command(command, PROBE_TIMEOUT).unwrap();
            assert_eq!(code, Some(0));
            let version = version_number(&output).expect("recognized packaged version");
            println!("{id} packaged runtime version: {version}");
        }
    }

    #[test]
    fn only_the_packaged_extensions_document_is_privileged() {
        for url in [
            "tauri://localhost/extensions.html",
            "http://tauri.localhost/extensions.html",
            "https://tauri.localhost/extensions.html",
        ] {
            assert!(allowed_document(&url::Url::parse(url).unwrap()));
        }
        for url in [
            "https://example.com/extensions.html",
            "http://127.0.0.1/extensions.html",
            "tauri://localhost/index.html",
            "http://tauri.localhost:4000/extensions.html",
            "http://user@tauri.localhost/extensions.html",
            "tauri://localhost/extensions.html?url=evil",
        ] {
            assert!(!allowed_document(&url::Url::parse(url).unwrap()));
        }
    }

    #[test]
    fn auth_checks_project_only_known_facts() {
        assert_eq!(
            auth_state("codex", Some(0), "", "Logged in using ChatGPT\n"),
            "authenticated"
        );
        assert_eq!(
            auth_state("codex", Some(1), "", "Not logged in\n"),
            "signed-out"
        );
        assert_eq!(
            auth_state("codex", Some(1), "", "connection failed"),
            "unknown"
        );
        assert_eq!(auth_state("codex", Some(0), "Usage: login", ""), "unknown");
        assert_eq!(
            auth_state(
                "claude",
                Some(0),
                r#"{"loggedIn":true,"email":"private@example.com"}"#,
                ""
            ),
            "authenticated"
        );
        assert_eq!(
            auth_state("claude", Some(1), r#"{"loggedIn":false}"#, ""),
            "signed-out"
        );
        assert_eq!(
            auth_state("claude", Some(1), r#"{"loggedIn":true}"#, ""),
            "unknown"
        );
        assert_eq!(auth_state("claude", Some(0), "invalid json", ""), "unknown");
    }

    #[test]
    fn versions_and_environment_do_not_expose_ambient_secrets() {
        assert_eq!(
            version_number("codex-cli 0.149.1\n"),
            Some("0.149.1".into())
        );
        assert_eq!(
            version_number("2.1.241 (Claude Code)"),
            Some("2.1.241".into())
        );
        assert_eq!(version_number("token=secret <script>"), None);
        for key in [
            "OPENAI_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "PASSWORD",
            "DSH_DESKTOP_BRIDGE_TOKEN",
            "NODE_OPTIONS",
            "DYLD_INSERT_LIBRARIES",
        ] {
            assert!(!safe_environment_key(key));
        }
        for key in [
            "HOME",
            "USERPROFILE",
            "PATH",
            "CODEX_HOME",
            "CLAUDE_CONFIG_DIR",
        ] {
            assert!(safe_environment_key(key));
        }
    }

    #[test]
    fn search_does_not_execute_from_a_relative_path() {
        let temporary = tempfile::tempdir().unwrap();
        let home = temporary.path();
        let paths = search_directories(
            Some(std::env::join_paths([Path::new("."), home]).unwrap()),
            home,
        );
        assert!(!paths.contains(&PathBuf::from(".")));
        assert!(paths.contains(&home.to_path_buf()));
        assert!(paths.contains(&home.join(".local/bin")));
        #[cfg(windows)]
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            assert!(paths.contains(&PathBuf::from(profile).join(".local").join("bin")));
        }
    }

    #[test]
    fn opt_ins_are_explicit_and_never_change_the_standard_preset() {
        let source = include_str!(
            "../../../../packages/preset/agent-presets/presets/standard/agent.cordis.yml"
        );
        assert_eq!(
            render_preset(source, &AgentPreferences::default()).unwrap(),
            source
        );
        let enabled = render_preset(
            source,
            &serde_json::from_str::<AgentPreferences>(r#"{"codex":true,"claude":true}"#).unwrap(),
        )
        .unwrap();
        assert!(!enabled.contains("disabled: true"));
        assert!(enabled.contains("toolName: subagent_codex"));
        assert!(enabled.contains("toolName: subagent_claude_code"));
        assert!(render_preset(
            &source.replace("tool-subagent-codex", "upstream-renamed"),
            &AgentPreferences::default()
        )
        .is_err());
    }

    #[test]
    fn preferences_and_generated_composition_survive_reads_without_enabling_by_default() {
        let temporary = tempfile::tempdir().unwrap();
        let home = temporary.path();
        let source = include_str!(
            "../../../../packages/preset/agent-presets/presets/standard/agent.cordis.yml"
        );
        let preset = home.join("standard.yml");
        std::fs::write(&preset, source).unwrap();
        let paths = IntegrationPaths {
            codex: home.join("codex.js"),
            claude: home.join("claude.js"),
            acp: home.join("acp.js"),
            preset,
        };
        let patch = materialize(home, &paths).unwrap();
        assert!(!patch.contains("subagent-codex"));
        assert!(!patch.contains("subagent-claude-code"));
        assert!(patch.contains("agent-presets"));
        assert!(!preferences(home).unwrap().enabled("codex"));
        assert!(validate_providers(
            &paths,
            &serde_json::from_str::<AgentPreferences>(r#"{"codex":true}"#).unwrap()
        )
        .is_err());
        std::fs::write(&paths.codex, "fixture").unwrap();
        atomic_write(
            &home.join("desktop-agents.json"),
            br#"{"codex":true,"claude":false}"#,
        )
        .unwrap();
        let patch = materialize(home, &paths).unwrap();
        assert!(patch.contains("subagent-codex"));
        assert!(!patch.contains("subagent-claude-code"));
        assert_eq!(std::fs::read_to_string(&paths.preset).unwrap(), source);
        atomic_write(
            &home.join("desktop-agents.json"),
            br#"{"codex":false,"claude":false}"#,
        )
        .unwrap();
        assert!(!materialize(home, &paths)
            .unwrap()
            .contains("subagent-codex"));
        atomic_write(
            &home.join("desktop-agents.json"),
            br#"{"codex":true,"claude":false,"command":"bad"}"#,
        )
        .unwrap();
        assert!(preferences(home).is_err());
    }

    #[test]
    fn catalog_and_preferences_reject_unknown_agents() {
        let entries = catalog();
        let ids: std::collections::BTreeSet<_> = entries.iter().map(|entry| &entry.id).collect();
        assert_eq!(ids.len(), entries.len());
        assert_eq!(
            entries
                .iter()
                .filter(|entry| entry.transport == "acp")
                .count(),
            2
        );
        for entry in &entries {
            assert_eq!(entry.command, entry.id);
            assert!(matches!(entry.transport.as_str(), "acp" | "sdk"));
            assert!(entry.docs.starts_with("https://"));
            assert!(entry.source.starts_with(
                "https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/"
            ));
            assert_eq!(entry.summary.len(), 2);
            for locale in ["en", "zh"] {
                assert!(!entry.summary.get(locale).unwrap().trim().is_empty());
            }
        }
        let value: AgentPreferences = serde_json::from_str(r#"{"unknown":true}"#).unwrap();
        assert!(value.validate().is_err());
        let value: AgentPreferences = serde_json::from_str(r#"{"codex":true}"#).unwrap();
        assert!(!value.enabled("kimi"));
        assert!(value.validate().is_ok());
    }

    #[test]
    fn acp_entries_fail_when_missing_and_keep_fixed_commands_and_reject_policy() {
        let temporary = tempfile::tempdir().unwrap();
        let home = temporary.path();
        let entries = catalog();
        let kimi = entries.iter().find(|entry| entry.id == "kimi").unwrap();
        assert!(acp_executable(kimi, &[home.to_path_buf()]).is_err());
        let executable = home.join(if cfg!(windows) { "kimi.exe" } else { "kimi" });
        std::fs::write(&executable, "fixture").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        assert_eq!(
            acp_executable(kimi, &[home.to_path_buf()]).unwrap(),
            executable
        );
        let source = include_str!(
            "../../../../packages/preset/agent-presets/presets/standard/agent.cordis.yml"
        );
        let value: AgentPreferences = serde_json::from_str(r#"{"kimi":true}"#).unwrap();
        let preset = render_preset(source, &value).unwrap();
        assert!(preset.contains("subagent_kimi"));
        assert!(!preset.contains("subagent_qoder"));
        assert!(preset.starts_with(source));
    }

    #[test]
    #[ignore = "Explicit local preflight only; does not run in CI or start inference"]
    fn installed_cli_preflight() {
        let home = PathBuf::from(
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap(),
        );
        let directories = search_directories(std::env::var_os("PATH"), &home);
        for entry in catalog() {
            let id = entry.id;
            let status = inspect(&id, &directories, &home);
            println!(
                "{id}: state={}, version={}, auth={}",
                status.state,
                status.version.as_deref().unwrap_or("unknown"),
                status.auth
            );
        }
    }

    #[test]
    #[ignore = "Requires desktop:prepare; boots the packaged Web profile without inference"]
    fn packaged_provider_and_preset_smoke() {
        let root = dunce::canonicalize(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."))
            .unwrap();
        let runtime = root.join("apps/desktop/resources/runtime");
        let packages = runtime.join("app/node_modules/@deepseek-ai");
        let paths = IntegrationPaths {
            codex: packages.join("dsh-subagent-codex/lib/index.js"),
            claude: packages.join("dsh-subagent-claude-code/lib/index.js"),
            acp: packages.join("dsh-subagent-acp/lib/index.js"),
            preset: packages.join("dsh-agent-presets/presets/standard/agent.cordis.yml"),
        };
        for enabled in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let home = temporary.path();
            atomic_write(
                &home.join("desktop-agents.json"),
                &serde_json::to_vec(&serde_json::json!({"codex":enabled,"claude":enabled,"kimi":enabled,"qoder":enabled}))
                    .unwrap(),
            )
            .unwrap();
            for id in ["kimi", "qoder"] {
                let file = home.join(if cfg!(windows) {
                    format!("{id}.exe")
                } else {
                    id.to_owned()
                });
                std::fs::write(&file, "protocol fixture executable").unwrap();
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o700)).unwrap();
                }
            }
            let patch = materialize_with_directories(home, &paths, &[home.to_path_buf()]).unwrap();
            let node = runtime
                .join("node")
                .join(if cfg!(windows) { "node.exe" } else { "node" });
            // Replace only external programs with the provider-owned protocol fixture; keep generated providers and tool grants.
            let mut patch: String = patch
                .lines()
                .filter(|line| !line.is_empty())
                .map(|line| {
                    let mut row: serde_json::Value =
                        serde_json::from_str(line.strip_prefix("- ").unwrap()).unwrap();
                    if let Some(providers) = row
                        .get_mut("insert")
                        .and_then(serde_json::Value::as_array_mut)
                    {
                        for provider in providers {
                            if let Some(config) = provider.get_mut("config") {
                                assert_eq!(config["permission"], "reject");
                                let id = config["providerName"].as_str().unwrap();
                                assert_eq!(
                                    config["args"],
                                    if id == "desktop-kimi" {
                                        serde_json::json!(["acp"])
                                    } else {
                                        serde_json::json!(["--acp"])
                                    }
                                );
                                config["command"] = serde_json::json!(node);
                                config["args"] = serde_json::json!([root.join(
                                    "packages/subagent/subagent-acp/tests/mock-acp-server.ts"
                                )]);
                            }
                        }
                    }
                    format!("\n- {row}\n")
                })
                .collect();
            let fixture =
                url::Url::from_file_path(root.join("apps/desktop/tests/fixtures/preset-smoke.mjs"))
                    .unwrap();
            patch.push_str(&format!("\n- {}\n", serde_json::json!({ "insert": [{"id": "desktop-preset-smoke", "name": fixture.as_str()}] })));
            let file = home.join("smoke.yml");
            std::fs::write(&file, patch).unwrap();
            let node = runtime
                .join("node")
                .join(if cfg!(windows) { "node.exe" } else { "node" });
            let mut command = command(
                &node,
                home,
                &search_directories(std::env::var_os("PATH"), home),
                &[],
            );
            command
                .arg(dunce::simplified(&packages.join("dsh/lib/bin.js")))
                .args(["web", "--patch"])
                .arg(file)
                .args(["--no-open", "--port", "0"])
                .env("DSH_HOME", home)
                .env("DSH_TELEMETRY_DISABLED", "1")
                .env("DSH_DESKTOP_SMOKE_ENABLED", if enabled { "1" } else { "0" });
            let (code, stdout, stderr) =
                super::super::runtime::probe_command(command, Duration::from_secs(45)).unwrap();
            assert_eq!(code, Some(0), "{stderr}");
            assert!(
                stdout.contains("DESKTOP_PRESETS_OK"),
                "Preset smoke did not complete"
            );
        }
    }
}
