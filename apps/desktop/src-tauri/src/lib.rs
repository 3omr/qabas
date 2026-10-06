//! Qabas application host for DeepSeek Harness.

mod bridge;
mod bundle_marketplace;
mod diagnostics;
mod local_agents;
mod locale;
mod marketplace;
mod navigation;
mod notebooklm;
mod profiles;
mod runtime;
mod startup;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use bridge::DesktopBridge;
use locale::text;
use navigation::RuntimeNavigation;
use rand::RngCore;
use runtime::{RuntimeConfig, RuntimeEvent, RuntimeSupervisor};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, WebviewWindowBuilder,
};
#[cfg(target_os = "macos")]
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;

struct DesktopState {
    runtime: Mutex<Option<RuntimeSupervisor>>,
    bridge: Mutex<Option<DesktopBridge>>,
}

#[derive(Clone)]
struct RuntimePaths {
    node: PathBuf,
    entry: PathBuf,
    patch: PathBuf,
    working_directory: PathBuf,
    desktop_native_entry: PathBuf,
    marketplace: bundle_marketplace::Paths,
    integrations: local_agents::IntegrationPaths,
    agent_probes: local_agents::ProbePaths,
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let _ = show_main_window(app);
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin({
            #[cfg(target_os = "macos")]
            {
                tauri_plugin_autostart::Builder::new()
                    .macos_launcher(MacosLauncher::LaunchAgent)
                    .build()
            }
            #[cfg(not(target_os = "macos"))]
            {
                tauri_plugin_autostart::Builder::new().build()
            }
        })
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_log::Builder::new().build())
        .manage(local_agents::AgentChecks::default())
        .manage(notebooklm::NotebookLmAuthManager::default())
        .invoke_handler(tauri::generate_handler![
            desktop_recovery,
            local_agents::desktop_local_agents,
            local_agents::desktop_agent_catalog,
            local_agents::desktop_agent_preferences,
            marketplace::desktop_skill_catalog,
            marketplace::desktop_skill_action
        ])
        .setup(setup);
    let app = builder
        .build(tauri::generate_context!())
        .expect("could not build Qabas");
    let signal_app = app.handle().clone();
    ctrlc::set_handler(move || signal_app.exit(0))
        .expect("could not install desktop termination handler");
    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if matches!(event, RunEvent::Reopen { .. }) {
            let _ = show_main_window(app);
        }
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            shutdown(app);
        }
    });
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let bridge_token = random_token();
    let window_config = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == "main")
        .ok_or("the desktop configuration must declare the main window")?;
    let navigation = Arc::new(Mutex::new(RuntimeNavigation::default()));
    let page_navigation = navigation.clone();
    let recovery_script = Arc::new(Mutex::new(None::<String>));
    let page_recovery = recovery_script.clone();
    let window = WebviewWindowBuilder::from_config(app, window_config)?
        .on_page_load(move |window, payload| {
            if let Ok(mut state) = page_navigation.lock() {
                state.page_load(payload.event(), payload.url());
            }
            // Fast spawn failures can arrive before the loading page installs its listeners.
            if payload.event() == tauri::webview::PageLoadEvent::Finished
                && is_loading_page(payload.url())
            {
                if let Ok(script) = page_recovery.lock() {
                    if let Some(script) = script.as_ref() {
                        let _ = window.eval(script);
                    }
                }
            }
        })
        .build()?;
    let close_window = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = close_window.hide();
        }
    });
    install_menu(app.handle())?;
    install_tray(app.handle())?;
    let startup = Arc::new(startup::StartupReadiness::default());
    let paths = runtime_paths(app.handle())?;
    let dsh_home = app.path().app_data_dir()?.join("harness");
    std::fs::create_dir_all(&dsh_home)?;
    let profiles = Arc::new(profiles::ProfileControl::new(dsh_home.clone()));
    let bridge = DesktopBridge::start(
        app.handle().clone(),
        bridge_token.clone(),
        startup.clone(),
        profiles.clone(),
    )?;
    let app_handle = app.handle().clone();
    let publish: Arc<dyn Fn(RuntimeEvent) + Send + Sync> = Arc::new(move |event| match event {
        RuntimeEvent::Starting(attempt) => {
            publish_recovery(&app_handle, &recovery_script, format!(
                    "dispatchEvent(new CustomEvent('dsh-desktop-runtime-starting', {{ detail: {attempt} }}));",
                ));
        }
        RuntimeEvent::Ready(url) => {
            let should_navigate = navigation
                .lock()
                .map(|mut state| state.runtime_ready(&url))
                .unwrap_or(true);
            if !should_navigate {
                return;
            }
            if let Some(window) = app_handle.get_webview_window("main") {
                if window.navigate(url).is_err() {
                    if let Ok(mut state) = navigation.lock() {
                        state.navigation_failed();
                    }
                    log::error!(target: "dsh_runtime", "Could not navigate to the Harness runtime");
                }
            }
        }
        RuntimeEvent::Error(message) => {
            log::error!(target: "dsh_runtime", "{message}");
            let detail = serde_json::to_string(&message)
                .unwrap_or_else(|_| "\"Unknown runtime error\"".to_owned());
            publish_recovery(&app_handle, &recovery_script, format!(
                    "dispatchEvent(new CustomEvent('dsh-desktop-runtime-error', {{ detail: {detail} }}));",
                ));
        }
        RuntimeEvent::Log(line) => log::info!(target: "dsh_runtime", "{line}"),
    });
    let runtime = RuntimeSupervisor::start(
        RuntimeConfig {
            node: paths.node,
            entry: paths.entry,
            patch: paths.patch,
            working_directory: paths.working_directory,
            desktop_native_entry: paths.desktop_native_entry,
            marketplace: paths.marketplace,
            integrations: paths.integrations,
            dsh_home,
            bridge_url: bridge.url.clone(),
            bridge_token,
            startup,
            profiles,
        },
        publish,
    );
    app.manage(DesktopState {
        runtime: Mutex::new(Some(runtime)),
        bridge: Mutex::new(Some(bridge)),
    });
    Ok(())
}

fn runtime_paths(app: &AppHandle) -> Result<RuntimePaths, Box<dyn std::error::Error>> {
    if cfg!(debug_assertions) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()?;
        return Ok(RuntimePaths {
            node: std::env::var_os("DSH_DESKTOP_NODE")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("node")),
            entry: root.join("apps/cli/lib/bin.js"),
            patch: root.join("apps/desktop/runtime/desktop.cordis.yml"),
            working_directory: root.clone(),
            desktop_native_entry: root.join("packages/desktop/desktop-native/lib/index.js"),
            marketplace: bundle_marketplace::Paths::development(&root),
            agent_probes: local_agents::ProbePaths {
                manifest: root.join("apps/desktop/resources/agent-runtimes.json"),
                root: root.clone(),
            },
            integrations: local_agents::IntegrationPaths {
                codex: root.join("packages/subagent/subagent-codex/lib/index.js"),
                claude: root.join("packages/subagent/subagent-claude-code/lib/index.js"),
                acp: root.join("packages/subagent/subagent-acp/lib/index.js"),
                preset: root
                    .join("packages/preset/agent-presets/presets/standard/agent.cordis.yml"),
            },
        });
    }
    let runtime = app.path().resource_dir()?.join("runtime");
    let node = runtime
        .join("node")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    Ok(RuntimePaths {
        node,
        entry: runtime.join("app/node_modules/@deepseek-ai/dsh/lib/bin.js"),
        patch: runtime.join("desktop.cordis.yml"),
        working_directory: runtime.join("app"),
        desktop_native_entry: runtime
            .join("app/node_modules/@deepseek-ai/dsh-desktop-native/lib/index.js"),
        marketplace: bundle_marketplace::Paths::packaged(&runtime),
        agent_probes: local_agents::ProbePaths {
            manifest: runtime.join("agent-runtimes.json"),
            root: runtime.clone(),
        },
        integrations: local_agents::IntegrationPaths {
            acp: runtime.join("app/node_modules/@deepseek-ai/dsh-subagent-acp/lib/index.js"),
            codex: runtime.join("app/node_modules/@deepseek-ai/dsh-subagent-codex/lib/index.js"),
            claude: runtime
                .join("app/node_modules/@deepseek-ai/dsh-subagent-claude-code/lib/index.js"),
            preset: runtime.join(
                "app/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard/agent.cordis.yml",
            ),
        },
    })
}

fn random_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn install_menu(app: &AppHandle) -> tauri::Result<()> {
    let retry = MenuItemBuilder::with_id("retry-runtime", text("Retry Runtime", "重启本地运行时"))
        .build(app)?;
    let new_session = MenuItemBuilder::with_id("new-session", text("New Session", "新建会话"))
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let settings = MenuItemBuilder::with_id("settings", text("Settings", "设置"))
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let extensions =
        MenuItemBuilder::with_id("extensions", text("Extensions…", "扩展中心…")).build(app)?;
    let export_diagnostics_item = MenuItemBuilder::with_id(
        "export-diagnostics",
        text("Export Diagnostics…", "导出诊断…"),
    )
    .build(app)?;
    let show =
        MenuItemBuilder::with_id("show", text("Show Qabas", "显示 Qabas"))
            .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Qabas")
        .item(&PredefinedMenuItem::about(
            app,
            Some(text("About Qabas", "关于 Qabas")),
            None,
        )?)
        .item(&show)
        .separator()
        .item(&settings)
        .item(&extensions)
        .item(&export_diagnostics_item)
        .item(&retry)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;
    let file = SubmenuBuilder::new(app, text("File", "文件"))
        .item(&new_session)
        .build()?;
    let edit = SubmenuBuilder::new(app, text("Edit", "编辑"))
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;
    let window = SubmenuBuilder::new(app, text("Window", "窗口"))
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .build()?;
    // macOS menu bars accept only submenus; keep that restriction type-checked.
    let submenus: &[&Submenu<_>] = &[&app_menu, &file, &edit, &window];
    let mut menu = MenuBuilder::new(app);
    for submenu in submenus {
        menu = menu.item(*submenu);
    }
    app.set_menu(menu.build()?)?;
    app.on_menu_event(|app, event| match event.id().as_ref() {
        "show" => {
            let _ = show_main_window(app);
        }
        "new-session" => eval_main(
            app,
            "dispatchEvent(new CustomEvent('dsh-desktop-new-session'))",
        ),
        "settings" => eval_main(
            app,
            "dispatchEvent(new CustomEvent('dsh-desktop-open-settings'))",
        ),
        "export-diagnostics" => export_diagnostics(app),
        "extensions" => {
            if let Err(error) = local_agents::show(app) {
                log::error!("Could not open extension center: {error}");
            }
        }
        "retry-runtime" => retry_runtime(app),
        _ => {}
    });
    Ok(())
}

fn install_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItemBuilder::with_id(
        "tray-show",
        text("Show Qabas", "显示 Qabas"),
    )
    .build(app)?;
    let quit = MenuItemBuilder::with_id("tray-quit", text("Quit", "退出")).build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&show)
        .separator()
        .item(&quit)
        .build()?;
    #[cfg(target_os = "macos")]
    let tray = TrayIconBuilder::new()
        .icon(tauri::include_image!("icons/tray.png"))
        .icon_as_template(true);
    #[cfg(not(target_os = "macos"))]
    let tray =
        TrayIconBuilder::new().icon(app.default_window_icon().cloned().expect("bundle icon"));
    tray.menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-show" => {
                let _ = show_main_window(app);
            }
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                let _ = show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn show_main_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        window.unminimize()?;
        window.show()?;
        window.set_focus()?;
    }
    Ok(())
}

fn retry_runtime(app: &AppHandle) {
    if let Some(state) = app.try_state::<DesktopState>() {
        if let Ok(runtime) = state.runtime.lock() {
            if let Some(runtime) = runtime.as_ref() {
                runtime.retry();
            }
        }
    }
}

fn is_loading_page(url: &url::Url) -> bool {
    let local = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"));
    local
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.path(), "/" | "/index.html")
}

/// Recovery commands belong only to the packaged loading document, never the runtime WebView.
#[tauri::command]
fn desktop_recovery(window: tauri::WebviewWindow, action: String) -> Result<(), String> {
    if !is_loading_page(&window.url().map_err(|error| error.to_string())?) {
        return Err("Recovery commands require the local loading page".to_owned());
    }
    match action.as_str() {
        "retry" => retry_runtime(window.app_handle()),
        "diagnostics" => export_diagnostics(window.app_handle()),
        _ => return Err("Unknown recovery action".to_owned()),
    }
    Ok(())
}

fn eval_main(app: &AppHandle, script: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(script);
    }
}

fn publish_recovery(app: &AppHandle, latest: &Mutex<Option<String>>, script: String) {
    if let Ok(mut latest) = latest.lock() {
        *latest = Some(script.clone());
    }
    eval_main(app, &script);
}

fn export_diagnostics(app: &AppHandle) {
    let handle = app.clone();
    app.dialog()
        .file()
        .set_title("Export Qabas Diagnostics")
        .set_file_name("Qabas-diagnostics.txt")
        .add_filter("Text", &["txt"])
        .save_file(move |destination| {
            let Some(destination) = destination else {
                return;
            };
            let result = destination
                .into_path()
                .map_err(|error| error.to_string())
                .and_then(|path| {
                    diagnostics::collect(&handle).and_then(|contents| {
                        std::fs::write(path, contents).map_err(|error| error.to_string())
                    })
                });
            let (title, body) = match result {
                Ok(()) => (
                    "Diagnostics exported",
                    "The redacted diagnostic file is ready.",
                ),
                Err(_) => (
                    "Diagnostics export failed",
                    "Qabas could not write the diagnostic file.",
                ),
            };
            let _ = handle
                .notification()
                .builder()
                .title(title)
                .body(body)
                .show();
        });
}

fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<DesktopState>() {
        if let Ok(mut runtime) = state.runtime.lock() {
            runtime.take();
        }
        if let Ok(mut bridge) = state.bridge.lock() {
            bridge.take();
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn recovery_commands_are_local_document_only() {
        for url in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html",
        ] {
            assert!(super::is_loading_page(&url::Url::parse(url).unwrap()));
        }
        for url in [
            "http://127.0.0.1:4000/",
            "https://example.com/",
            "http://tauri.localhost:4000/",
            "http://user@tauri.localhost/",
            "tauri://localhost/other.html",
        ] {
            assert!(!super::is_loading_page(&url::Url::parse(url).unwrap()));
        }
    }
    #[test]
    fn main_window_delivers_native_file_drops_and_setup_owned_creation() {
        let config: tauri::Config = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("the shipped Tauri configuration must parse");
        let window = config
            .app
            .windows
            .iter()
            .find(|window| window.label == "main")
            .expect("the main window must be configured");
        assert!(window.drag_drop_enabled, "native file drops must reach the WebView");
        assert!(!window.create, "setup owns main-window creation");
        assert!(
            window.visible,
            "the loading window must be immediately visible"
        );
    }
}
