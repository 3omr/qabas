//! Packaged CLI acceptance of the native Profile supervisor, without a GUI or model request.

use super::*;
use crate::profiles::{Candidate, ProfileControl};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    sync::atomic::{AtomicBool, Ordering},
};
use tiny_http::{Response, Server};

struct TestBridge {
    url: String,
    stop: Arc<AtomicBool>,
    join: Option<thread::JoinHandle<()>>,
}

impl TestBridge {
    fn new(startup: Arc<crate::startup::StartupReadiness>, profiles: Arc<ProfileControl>) -> Self {
        let server = Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}", server.server_addr());
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let join = thread::spawn(move || {
            while !stopping.load(Ordering::Acquire) {
                let Some(mut request) = server.recv_timeout(Duration::from_millis(100)).unwrap()
                else {
                    continue;
                };
                assert!(request
                    .headers()
                    .iter()
                    .any(|header| header.field.equiv("x-dsh-desktop-bridge-token")
                        && header.value.as_str() == "profile-selection-test-token"));
                request = match crate::bridge::handle_profile_request(request, &profiles) {
                    None => continue,
                    Some(request) => request,
                };
                assert_eq!(request.url(), "/v1/runtime-ready");
                let mut body = String::new();
                request
                    .as_reader()
                    .take(4096)
                    .read_to_string(&mut body)
                    .unwrap();
                let body: serde_json::Value = serde_json::from_str(&body).unwrap();
                startup.confirm(body["attempt"].as_str().unwrap()).unwrap();
                request
                    .respond(Response::from_string(r#"{"ok":true}"#))
                    .unwrap();
            }
        });
        Self {
            url,
            stop,
            join: Some(join),
        }
    }
}

impl Drop for TestBridge {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(join) = self.join.take() {
            join.join().unwrap();
        }
    }
}

fn wait_ready(events: &mpsc::Receiver<RuntimeEvent>) -> Url {
    let deadline = Instant::now() + Duration::from_secs(90);
    let mut errors = Vec::new();
    let mut logs = std::collections::VecDeque::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match events.recv_timeout(remaining) {
            Ok(RuntimeEvent::Ready(url)) => return url,
            Ok(RuntimeEvent::Error(error)) => errors.push(error),
            Ok(RuntimeEvent::Log(line)) => {
                if logs.len() == 40 {
                    logs.pop_front();
                }
                logs.push_back(line);
            }
            Ok(RuntimeEvent::Starting(_)) => {}
            Err(error) => panic!("Profile runtime did not become ready: {error}; {errors:?}; {logs:?}"),
        }
    }
}

fn start(config: RuntimeConfig) -> (RuntimeSupervisor, mpsc::Receiver<RuntimeEvent>) {
    let (send, receive) = mpsc::channel();
    let supervisor = RuntimeSupervisor::start(
        config,
        Arc::new(move |event| {
            let _ = send.send(event);
        }),
    );
    (supervisor, receive)
}

fn queue_overlay(
    config: &RuntimeConfig,
    runtime: &Path,
    root: &Path,
) -> (PathBuf, PathBuf, PathBuf) {
    let home = &config.dsh_home;
    let fixture = home.join("fixture-bundle");
    let artifacts = home.join("artifacts");
    fs::create_dir(&fixture).unwrap();
    fs::create_dir(&artifacts).unwrap();
    let name = "dsh-profile-selection-fixture";
    fs::write(
        fixture.join("package.json"),
        serde_json::json!({
            "name": name, "version": "1.0.0", "type": "module", "exports": "./host.mjs",
            "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
        })
        .to_string(),
    )
    .unwrap();
    fs::write(
        fixture.join("host.mjs"),
        include_str!("../../tests/fixtures/profile-selection.mjs"),
    )
    .unwrap();
    let receipt = home.join("candidate-1.json");
    fs::write(fixture.join("cordis.patch.yml"), serde_json::json!([{ "insert": [{
        "id": "prepared-bundle-startup-observer", "name": name, "config": { "receipt": receipt, "fail": false }
    }] }]).to_string()).unwrap();
    let manager = runtime.join("tools/pnpm/bin/pnpm.mjs");
    let mut pack = Command::new(&config.node);
    pack.env_clear()
        .current_dir(&fixture)
        .arg(dunce::simplified(&manager))
        .args(["pack", "--pack-destination"])
        .arg(&artifacts)
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("PATH", runtime.join("node"))
        .env("npm_config_manage_package_manager_versions", "false");
    for (key, value) in std::env::vars_os().filter(|(key, _)| {
        matches!(
            key.to_string_lossy().to_ascii_uppercase().as_str(),
            "SYSTEMROOT" | "WINDIR" | "COMSPEC" | "TEMP" | "TMP"
        )
    }) {
        pack.env(key, value);
    }
    let (code, _, error) = probe_command(pack, Duration::from_secs(60)).unwrap();
    assert_eq!(code, Some(0), "{error}");
    let artifact = format!("{name}-1.0.0.tgz");
    let bytes = fs::read(artifacts.join(&artifact)).unwrap();
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(runtime.join("runtime-manifest.json")).unwrap()).unwrap();
    let catalog = home.join("fixture-catalog.json");
    fs::write(&catalog, serde_json::json!({ "schemaVersion": 1, "entries": [{
        "id": "fixture", "packageName": name, "version": "1.0.0", "title": "Profile fixture", "publisher": "Local test",
        "details": null,
        "source": "https://github.com/Bestbbb/deepseek-harness-desktop", "harnessVersions": [manifest["harnessVersion"]],
        "platforms": [format!("{}-{}", manifest["platform"].as_str().unwrap(), manifest["arch"].as_str().unwrap())],
        "artifact": { "file": artifact, "size": bytes.len(), "sha256": format!("{:x}", Sha256::digest(&bytes)) }
    }] }).to_string()).unwrap();
    let result = home.join("queue-result.json");
    let patch = home.join("queue-overlay.yml");
    let service = Url::from_file_path(
        runtime.join("app/node_modules/@deepseek-ai/dsh-bundle-preparation/lib/index.js"),
    )
    .unwrap();
    let consumer =
        Url::from_file_path(root.join("apps/desktop/tests/fixtures/queue-bundle.mjs")).unwrap();
    let preparation_row = serde_json::json!(
        { "id": "desktop-bundle-preparation", "name": service, "config": {
            "catalogFile": catalog, "artifactDirectory": artifacts, "stagingDirectory": home.join("prepared"), "hostVersion": manifest["harnessVersion"],
            "installer": { "nodeExecutable": config.node, "packageManagerEntry": manager, "packageManagerVersion": manifest["pnpmVersion"],
                "timeoutMs": 60000, "graceMs": 1000, "maxOutputBytes": 65536, "maxExpandedBytes": 134217728, "maxArchiveEntries": 10000, "maxManifestBytes": 1048576 },
            "composition": { "harnessHome": home, "profileName": "web", "dshEntry": config.entry, "maxProfileBytes": 536870912, "maxProfileEntries": 100000 },
            "journal": { "directory": home.join("operations"), "maxEntries": 100, "maxRecordBytes": 1048576 }
        } });
    let row = serde_json::json!({ "insert": [
        { "id": "queue-consumer", "name": consumer, "config": { "id": "fixture", "resultFile": result } }
    ] });
    fs::write(
        &patch,
        format!(
            "{}\n- {preparation_row}\n- {row}\n",
            fs::read_to_string(&config.patch).unwrap()
        ),
    )
    .unwrap();
    (patch, result, receipt)
}

fn wait_queue(path: &Path) -> Candidate {
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        match fs::read(path) {
            Ok(bytes) => {
                return serde_json::from_slice(&bytes)
                    .expect("Cordis Bundle preparation did not queue the fixture")
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound && Instant::now() < deadline =>
            {
                thread::sleep(Duration::from_millis(50))
            }
            Err(error) => panic!("Bundle queue result unavailable: {error}"),
        }
    }
}

fn prepare_candidate(
    home: &Path,
    root: &Path,
    suffix: u8,
    previous: &str,
    fail: bool,
) -> (Candidate, PathBuf) {
    let profile = format!("desktop-00000000-0000-4000-8000-{suffix:012}");
    let directory = home.join("profiles").join(&profile);
    fs::create_dir_all(&directory).unwrap();
    let receipt = home.join(format!("candidate-{suffix}.json"));
    let manifest = serde_json::to_vec(&serde_json::json!({
        "name": format!("dsh-profile-{profile}"), "private": true, "dependencies": {},
        "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"], "patchReload": "startup" } }
    })).unwrap();
    fs::write(directory.join("package.json"), &manifest).unwrap();
    let fixture =
        Url::from_file_path(root.join("apps/desktop/tests/fixtures/profile-selection.mjs"))
            .unwrap();
    let patch = serde_json::json!([{ "insert": [{ "id": "candidate-startup-observer", "name": fixture, "config": { "receipt": receipt, "fail": fail } }] }]);
    fs::write(directory.join("cordis.patch.yml"), patch.to_string()).unwrap();
    (
        Candidate {
            profile,
            previous_profile: previous.into(),
            manifest_sha256: format!("{:x}", Sha256::digest(&manifest)),
        },
        receipt,
    )
}

#[test]
#[ignore = "Requires desktop:prepare; exercises real packaged Profile selection and recovery without inference"]
fn packaged_profile_selection_and_recovery() {
    let root = dunce::canonicalize(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."))
        .unwrap();
    let runtime = root.join("apps/desktop/resources/runtime");
    let packages = runtime.join("app/node_modules/@deepseek-ai");
    let home = tempfile::tempdir().unwrap();
    let startup = Arc::new(crate::startup::StartupReadiness::default());
    let profiles = Arc::new(ProfileControl::new(home.path().into()));
    let bridge = TestBridge::new(startup.clone(), profiles.clone());
    let mut config = RuntimeConfig {
        node: runtime
            .join("node")
            .join(if cfg!(windows) { "node.exe" } else { "node" }),
        entry: packages.join("dsh/lib/bin.js"),
        patch: runtime.join("desktop.cordis.yml"),
        // The packaged engine overlay belongs to the application directory; data remains in the private home.
        working_directory: runtime.join("app"),
        desktop_native_entry: packages.join("dsh-desktop-native/lib/index.js"),
        marketplace: crate::bundle_marketplace::Paths::packaged(&runtime),
        integrations: crate::local_agents::IntegrationPaths {
            codex: packages.join("dsh-subagent-codex/lib/index.js"),
            claude: packages.join("dsh-subagent-claude-code/lib/index.js"),
            acp: packages.join("dsh-subagent-acp/lib/index.js"),
            preset: packages.join("dsh-agent-presets/presets/standard/agent.cordis.yml"),
        },
        dsh_home: home.path().into(),
        bridge_url: bridge.url.clone(),
        bridge_token: "profile-selection-test-token".into(),
        startup,
        profiles: profiles.clone(),
    };
    let (overlay, queue_result, receipt) = queue_overlay(&config, &runtime, &root);
    let original_patch = config.patch.clone();
    config.patch = overlay;
    let (mut supervisor, events) = start(config.clone());
    wait_ready(&events);
    let base_manifest = fs::read(home.path().join("profiles/web/package.json")).unwrap();
    let candidate = wait_queue(&queue_result);
    assert_eq!(candidate.previous_profile, "web");
    supervisor.retry();
    wait_ready(&events);
    assert!(
        !receipt.exists(),
        "Runtime Retry must not consume next-application queue"
    );
    assert_eq!(profiles.selection().unwrap().active_profile, "web");
    supervisor.shutdown();

    config.patch = original_patch;
    config.profiles = Arc::new(ProfileControl::new(home.path().into()));
    let (mut supervisor, events) = start(config.clone());
    wait_ready(&events);
    assert_eq!(
        config.profiles.selection().unwrap().active_profile,
        candidate.profile
    );
    let observed: serde_json::Value = serde_json::from_slice(&fs::read(&receipt).unwrap()).unwrap();
    assert_eq!(
        observed,
        serde_json::json!({ "profile": candidate.profile, "home": home.path() })
    );
    let (broken, failed_receipt) =
        prepare_candidate(home.path(), &root, 2, &candidate.profile, true);
    config.profiles.queue(broken.clone()).unwrap();
    supervisor.shutdown();

    config.profiles = Arc::new(ProfileControl::new(home.path().into()));
    let (mut supervisor, events) = start(config.clone());
    wait_ready(&events);
    assert!(
        failed_receipt.is_file(),
        "The candidate must actually execute before recovery"
    );
    assert_eq!(
        config.profiles.selection().unwrap().active_profile,
        candidate.profile
    );
    let record: serde_json::Value = serde_json::from_slice(
        &fs::read(home.path().join("desktop-profile-selection.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        record["lastFailure"]["candidate"]["profile"],
        broken.profile
    );
    assert_eq!(record["lastFailure"]["reason"], "startup-failed");
    assert!(record["trial"].is_null());
    assert_eq!(
        fs::read(home.path().join("profiles/web/package.json")).unwrap(),
        base_manifest
    );
    supervisor.shutdown();
}
