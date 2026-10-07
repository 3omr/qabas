//! Pinned, data-only Skill bundles. Installation publishes a complete directory without replacement.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, io::Read, path::Path, sync::Mutex, time::Duration};
use tauri::Manager;

const MAX_FILE_BYTES: u64 = 128 * 1024;
static OPERATIONS: Mutex<()> = Mutex::new(());

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct SkillFile {
    name: String,
    path: String,
    sha256: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct SkillEntry {
    id: String,
    name: String,
    author: String,
    license: String,
    repository: String,
    revision: String,
    summary: BTreeMap<String, String>,
    files: Vec<SkillFile>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum InstallState {
    NotInstalled,
    Installed,
    Conflict,
}

#[derive(Serialize)]
pub(crate) struct SkillListing {
    #[serde(flatten)]
    entry: SkillEntry,
    state: InstallState,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SkillAction {
    Preview,
    Install,
    Uninstall,
}

#[derive(Serialize)]
pub(crate) struct SkillResult {
    state: InstallState,
    content: Option<BTreeMap<String, String>>,
    recovery: Option<String>,
}

fn catalog() -> Vec<SkillEntry> {
    serde_json::from_str(include_str!("../../loading/skills.json")).expect("packaged skill catalog")
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn receipt(entry: &SkillEntry) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "schema": 1, "id": entry.id, "revision": entry.revision,
        "files": entry.files,
    }))
    .expect("skill receipt")
}

fn regular_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "skill-file-unreadable")?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        return Err("skill-file-conflict".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| "skill-file-unreadable")?
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "skill-file-unreadable")?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("skill-file-conflict".into());
    }
    Ok(bytes)
}

// Missing directories are allowed during read-only discovery, but links and non-directories are not.
fn check_directory(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err("skill-directory-conflict".into()),
    }
}

fn check_roots(home: &Path) -> Result<(), String> {
    check_directory(home)?;
    check_directory(&home.join("skills"))
}

fn installed(home: &Path, entry: &SkillEntry) -> Result<InstallState, String> {
    check_roots(home)?;
    let target = home.join("skills").join(&entry.id);
    match fs::symlink_metadata(&target) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(InstallState::NotInstalled)
        }
        Ok(metadata) if metadata.is_dir() => {}
        _ => return Ok(InstallState::Conflict),
    }
    let verified = || -> Result<bool, String> {
        if regular_bytes(&target.join(".desktop-receipt.json"))? != receipt(entry) {
            return Ok(false);
        }
        if fs::read_dir(&target)
            .map_err(|_| "skill-file-unreadable")?
            .count()
            != entry.files.len() + 1
        {
            return Ok(false);
        }
        for file in &entry.files {
            if digest(&regular_bytes(&target.join(&file.name))?) != file.sha256 {
                return Ok(false);
            }
        }
        Ok(true)
    };
    Ok(if verified().unwrap_or(false) {
        InstallState::Installed
    } else {
        InstallState::Conflict
    })
}

fn verify_file(file: &SkillFile, bytes: Vec<u8>) -> Result<String, String> {
    if bytes.len() as u64 > MAX_FILE_BYTES || digest(&bytes) != file.sha256 {
        return Err("skill-integrity-failed".into());
    }
    String::from_utf8(bytes).map_err(|_| "skill-invalid-text".into())
}

fn download(entry: &SkillEntry) -> Result<BTreeMap<String, String>, String> {
    // Reuse the updater's ring backend; an already installed process-wide provider wins.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "skill-download-failed")?;
    let mut files = BTreeMap::new();
    for file in &entry.files {
        let url = format!(
            "https://raw.githubusercontent.com/{}/{}/{}",
            entry.repository, entry.revision, file.path
        );
        let response = client
            .get(url)
            .send()
            .map_err(|_| "skill-download-failed")?;
        if response.status() != reqwest::StatusCode::OK {
            return Err("skill-download-failed".into());
        }
        let mut bytes = Vec::new();
        response
            .take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "skill-download-failed")?;
        files.insert(file.name.clone(), verify_file(file, bytes)?);
    }
    Ok(files)
}

// Ordinary rename may replace an empty user directory on Unix; the publish operation must not.
#[cfg(unix)]
fn publish_directory(source: &Path, target: &Path) -> Result<(), String> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let source = CString::new(source.as_os_str().as_bytes()).map_err(|_| "skill-invalid-path")?;
    let target = CString::new(target.as_os_str().as_bytes()).map_err(|_| "skill-invalid-path")?;
    #[cfg(target_os = "macos")]
    let result = unsafe { libc::renamex_np(source.as_ptr(), target.as_ptr(), libc::RENAME_EXCL) };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result != 0 {
        return Err("skill-publish-failed".into());
    }
    Ok(())
}

#[cfg(windows)]
fn publish_directory(source: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

    // Canonical parents retain extended-length paths; the destination must not exist yet.
    let source = fs::canonicalize(source).map_err(|_| "skill-invalid-path")?;
    let target = fs::canonicalize(target.parent().ok_or("skill-invalid-path")?)
        .map_err(|_| "skill-invalid-path")?
        .join(target.file_name().ok_or("skill-invalid-path")?);
    let mut source: Vec<u16> = source.as_os_str().encode_wide().collect();
    let mut target: Vec<u16> = target.as_os_str().encode_wide().collect();
    if source.contains(&0) || target.contains(&0) {
        return Err("skill-invalid-path".into());
    }
    source.push(0);
    target.push(0);
    // No REPLACE_EXISTING or COPY_ALLOWED: one same-volume move must reject occupied targets.
    let result = unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 0) };
    if result == 0 {
        return Err("skill-publish-failed".into());
    }
    Ok(())
}

fn install(
    home: &Path,
    entry: &SkillEntry,
    files: &BTreeMap<String, String>,
) -> Result<(), String> {
    if installed(home, entry)? != InstallState::NotInstalled {
        return Err("skill-file-conflict".into());
    }
    for file in &entry.files {
        let bytes = files
            .get(&file.name)
            .ok_or("skill-integrity-failed")?
            .as_bytes()
            .to_vec();
        verify_file(file, bytes)?;
    }
    fs::create_dir_all(home).map_err(|_| "skill-directory-unwritable")?;
    let temporary = tempfile::Builder::new()
        .prefix(".desktop-skill-stage-")
        .tempdir_in(home)
        .map_err(|_| "skill-directory-unwritable")?;
    let staged = temporary.path().join(&entry.id);
    fs::create_dir(&staged).map_err(|_| "skill-directory-unwritable")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&staged, fs::Permissions::from_mode(0o700))
            .map_err(|_| "skill-directory-unwritable")?;
    }
    for file in &entry.files {
        fs::write(staged.join(&file.name), &files[&file.name])
            .map_err(|_| "skill-file-unwritable")?;
    }
    fs::write(staged.join(".desktop-receipt.json"), receipt(entry))
        .map_err(|_| "skill-file-unwritable")?;
    check_roots(home)?;
    fs::create_dir_all(home.join("skills")).map_err(|_| "skill-directory-unwritable")?;
    publish_directory(&staged, &home.join("skills").join(&entry.id))
}

fn uninstall(home: &Path, entry: &SkillEntry) -> Result<String, String> {
    if installed(home, entry)? != InstallState::Installed {
        return Err("skill-file-conflict".into());
    }
    let recovery_root = home.join("desktop-skill-recovery");
    check_directory(&recovery_root)?;
    fs::create_dir_all(&recovery_root).map_err(|_| "skill-directory-unwritable")?;
    let recovery = tempfile::Builder::new()
        .prefix("removed-")
        .tempdir_in(&recovery_root)
        .map_err(|_| "skill-directory-unwritable")?;
    let target = recovery.path().join(&entry.id);
    publish_directory(&home.join("skills").join(&entry.id), &target)?;
    let _ = recovery.keep();
    Ok(target.to_string_lossy().into_owned())
}

fn home(window: &tauri::WebviewWindow) -> Result<std::path::PathBuf, String> {
    if window.label() != "extensions"
        || !super::local_agents::allowed_document(&window.url().map_err(|_| "invalid-window")?)
    {
        return Err("local-document-required".into());
    }
    Ok(window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|_| "home-unavailable")?
        .join("harness"))
}

/// Read packaged metadata and local integrity states without network access or filesystem writes.
#[tauri::command]
pub(crate) async fn desktop_skill_catalog(
    window: tauri::WebviewWindow,
) -> Result<Vec<SkillListing>, String> {
    let home = home(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = OPERATIONS.try_lock().map_err(|_| "skill-operation-busy")?;
        catalog()
            .into_iter()
            .map(|entry| {
                Ok(SkillListing {
                    state: installed(&home, &entry)?,
                    entry,
                })
            })
            .collect()
    })
    .await
    .map_err(|_| "skill-operation-failed")?
}

/// Operate only on a pinned catalog entry; installs require the revision confirmed by the UI.
#[tauri::command]
pub(crate) async fn desktop_skill_action(
    window: tauri::WebviewWindow,
    id: String,
    revision: String,
    action: SkillAction,
) -> Result<SkillResult, String> {
    let home = home(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = OPERATIONS.try_lock().map_err(|_| "skill-operation-busy")?;
        let entry = catalog()
            .into_iter()
            .find(|entry| entry.id == id && entry.revision == revision)
            .ok_or("skill-unknown-revision")?;
        let mut content = None;
        let mut recovery = None;
        match action {
            SkillAction::Preview => content = Some(download(&entry)?),
            SkillAction::Install => {
                if installed(&home, &entry)? != InstallState::NotInstalled {
                    return Err("skill-file-conflict".into());
                }
                install(&home, &entry, &download(&entry)?)?;
            }
            SkillAction::Uninstall => recovery = Some(uninstall(&home, &entry)?),
        }
        Ok(SkillResult {
            state: installed(&home, &entry)?,
            content,
            recovery,
        })
    })
    .await
    .map_err(|_| "skill-operation-failed")?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (SkillEntry, BTreeMap<String, String>) {
        let mut entry = catalog().remove(0);
        let files: BTreeMap<_, _> = entry
            .files
            .iter()
            .map(|file| (file.name.clone(), format!("fixture {}", file.name)))
            .collect();
        for file in &mut entry.files {
            file.sha256 = digest(files[&file.name].as_bytes());
        }
        (entry, files)
    }

    fn packaged_smoke(home: &Path, present: bool, text: &str) {
        let root = dunce::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."))
            .unwrap();
        let runtime = root.join("apps/desktop/resources/runtime");
        let node = runtime
            .join("node")
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        let fixture =
            url::Url::from_file_path(root.join("apps/desktop/tests/fixtures/skill-smoke.mjs"))
                .unwrap();
        let patch = home.join("skill-smoke.yml");
        fs::write(&patch, format!("- {}\n", serde_json::json!({ "insert": [{ "id": "desktop-skill-smoke", "name": fixture.as_str() }] }))).unwrap();
        let mut command = std::process::Command::new(node);
        command.env_clear().current_dir(home);
        for key in ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command
            .arg(dunce::simplified(&runtime.join("app/node_modules/@deepseek-ai/dsh/lib/bin.js")))
            .args(["web", "--patch"])
            .arg(patch)
            .args(["--no-open", "--port", "0"])
            .env("DSH_HOME", home)
            .env("DSH_AGENTS_HOME", home.join("isolated-agents"))
            .env("TRANSCRIBER_WORKSPACE", home)
            .env("DSH_TELEMETRY_DISABLED", "1")
            .env("DSH_SKILL_INSTALLED", if present { "1" } else { "0" })
            .env("DSH_SKILL_EXPECTED_TEXT", text);
        let (code, stdout, stderr) =
            super::super::runtime::probe_command(command, Duration::from_secs(45)).unwrap();
        assert_eq!(code, Some(0), "{stderr}");
        assert!(
            stdout.contains("DESKTOP_SKILLS_OK"),
            "Skill smoke did not complete"
        );
    }

    #[test]
    #[ignore = "Requires desktop:prepare; verifies installed Skill discovery through the packaged Web profile"]
    fn packaged_skill_lifecycle() {
        let root = tempfile::tempdir().unwrap();
        let (mut entry, mut files) = fixture();
        files.insert("SKILL.md".into(), "---\nname: frontend-design\ndescription: Desktop installation fixture.\n---\nDesktop installed skill fixture.\n".into());
        entry.files[0].sha256 = digest(files["SKILL.md"].as_bytes());
        packaged_smoke(root.path(), false, "Desktop installed skill fixture.");
        install(root.path(), &entry, &files).unwrap();
        packaged_smoke(root.path(), true, "Desktop installed skill fixture.");
        uninstall(root.path(), &entry).unwrap();
        packaged_smoke(root.path(), false, "Desktop installed skill fixture.");
    }

    #[test]
    fn catalog_limits_installs_to_pinned_text_and_license_files() {
        for entry in catalog() {
            assert_eq!(entry.id, "frontend-design");
            assert_eq!(entry.repository, "anthropics/skills");
            assert_eq!(entry.revision.len(), 40);
            assert!(entry.revision.bytes().all(|byte| byte.is_ascii_hexdigit()));
            assert_eq!(
                entry
                    .files
                    .iter()
                    .map(|file| file.name.as_str())
                    .collect::<Vec<_>>(),
                ["SKILL.md", "LICENSE.txt", "THIRD_PARTY_NOTICES.md"]
            );
            for file in entry.files {
                assert!(!file.path.starts_with('/'));
                assert!(!file.path.contains(".."));
                assert_eq!(file.sha256.len(), 64);
                assert!(file.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()));
            }
            for language in ["en", "zh"] {
                assert!(!entry.summary[language].is_empty());
            }
        }
    }

    #[test]
    fn install_is_verified_and_uninstall_retains_recoverable_files() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let (entry, files) = fixture();
        assert_eq!(
            installed(&home, &entry).unwrap(),
            InstallState::NotInstalled
        );
        assert!(!home.exists());
        install(&home, &entry, &files).unwrap();
        assert_eq!(installed(&home, &entry).unwrap(), InstallState::Installed);
        assert!(install(&home, &entry, &files).is_err());
        let recovery = uninstall(&home, &entry).unwrap();
        assert_eq!(
            installed(&home, &entry).unwrap(),
            InstallState::NotInstalled
        );
        assert_eq!(
            fs::read_to_string(Path::new(&recovery).join("SKILL.md")).unwrap(),
            files["SKILL.md"]
        );
        install(&home, &entry, &files).unwrap();
        assert_eq!(installed(&home, &entry).unwrap(), InstallState::Installed);
    }

    #[test]
    fn bad_downloads_and_user_files_are_never_published_or_overwritten() {
        let root = tempfile::tempdir().unwrap();
        let (entry, mut files) = fixture();
        files.insert("SKILL.md".into(), "wrong hash".into());
        assert!(install(root.path(), &entry, &files).is_err());
        assert!(!root.path().join("skills").exists());
        let (entry, files) = fixture();
        let target = root.path().join("skills").join(&entry.id);
        fs::create_dir_all(&target).unwrap();
        assert!(install(root.path(), &entry, &files).is_err());
        assert!(uninstall(root.path(), &entry).is_err());
        let source = root.path().join("source");
        fs::create_dir(&source).unwrap();
        assert!(publish_directory(&source, &target).is_err());
        assert!(source.is_dir());
        assert!(target.is_dir());
    }

    #[test]
    fn publication_preserves_occupied_unicode_paths() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("待安装 source");
        let target = root.path().join("用户 target");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("SKILL.md"), "reviewed bytes").unwrap();
        fs::write(&target, "user bytes").unwrap();
        assert!(publish_directory(&source, &target).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "user bytes");
        fs::remove_file(&target).unwrap();
        fs::create_dir(&target).unwrap();
        fs::write(target.join("notes.txt"), "user bytes").unwrap();
        assert!(publish_directory(&source, &target).is_err());
        assert_eq!(fs::read_to_string(target.join("notes.txt")).unwrap(), "user bytes");
        fs::remove_file(target.join("notes.txt")).unwrap();
        assert!(publish_directory(&source, &target).is_err());
        fs::remove_dir(&target).unwrap();
        publish_directory(&source, &target).unwrap();
        assert!(!source.exists());
        assert_eq!(fs::read_to_string(target.join("SKILL.md")).unwrap(), "reviewed bytes");
    }

    #[test]
    fn changed_or_extra_files_block_uninstall() {
        for extra in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let (entry, files) = fixture();
            install(root.path(), &entry, &files).unwrap();
            let target = root.path().join("skills").join(&entry.id);
            let file = target.join(if extra { "user-notes.txt" } else { "SKILL.md" });
            fs::write(&file, "user changes").unwrap();
            assert_eq!(
                installed(root.path(), &entry).unwrap(),
                InstallState::Conflict
            );
            assert!(uninstall(root.path(), &entry).is_err());
            assert_eq!(fs::read_to_string(file).unwrap(), "user changes");
        }
    }

    #[test]
    fn concurrent_publication_has_one_winner_and_preserves_the_loser() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("target");
        let barrier = std::sync::Barrier::new(2);
        let results = std::thread::scope(|scope| {
            let workers: Vec<_> = ["first", "second"]
                .into_iter()
                .map(|name| {
                    let source = root.path().join(name);
                    fs::create_dir(&source).unwrap();
                    fs::write(source.join("value"), name).unwrap();
                    let barrier = &barrier;
                    let target = &target;
                    scope.spawn(move || {
                        barrier.wait();
                        let published = publish_directory(&source, target).is_ok();
                        if !published {
                            assert_eq!(fs::read_to_string(source.join("value")).unwrap(), name);
                        }
                        published
                    })
                })
                .collect();
            workers
                .into_iter()
                .map(|worker| worker.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert_eq!(results.iter().filter(|result| **result).count(), 1);
        assert!(target.join("value").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn linked_skill_roots_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(external.path(), root.path().join("skills")).unwrap();
        let (entry, files) = fixture();
        assert!(install(root.path(), &entry, &files).is_err());
        assert!(installed(root.path(), &entry).is_err());
        assert_eq!(fs::read_dir(external.path()).unwrap().count(), 0);
    }

    #[test]
    #[ignore = "Explicit network acceptance; downloads the pinned Skill into a private temporary home"]
    fn pinned_remote_skill_install_and_removal() {
        let root = tempfile::tempdir().unwrap();
        let entry = catalog().remove(0);
        let files = download(&entry).unwrap();
        assert!(files["SKILL.md"].contains("name: frontend-design"));
        install(root.path(), &entry, &files).unwrap();
        assert_eq!(
            installed(root.path(), &entry).unwrap(),
            InstallState::Installed
        );
        packaged_smoke(root.path(), true, "# Frontend Design");
        uninstall(root.path(), &entry).unwrap();
        assert_eq!(
            installed(root.path(), &entry).unwrap(),
            InstallState::NotInstalled
        );
    }
}
