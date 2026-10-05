//! Private authenticated RPC from the TypeScript runtime into the native host.

use serde::Deserialize;
use std::{
    io::Read,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};
use subtle::ConstantTimeEq;
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_notification::NotificationExt;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

const TOKEN_HEADER: &str = "x-dsh-desktop-bridge-token";
const MAX_BODY_BYTES: u64 = 64 * 1024;

pub struct DesktopBridge {
    pub url: String,
    stop: Arc<AtomicBool>,
    join: Option<thread::JoinHandle<()>>,
}

impl DesktopBridge {
    pub fn start(
        app: AppHandle,
        token: String,
        startup: Arc<super::startup::StartupReadiness>,
        profiles: Arc<super::profiles::ProfileControl>,
    ) -> Result<Self, String> {
        let server = Server::http("127.0.0.1:0")
            .map_err(|error| format!("Could not bind native bridge: {error}"))?;
        let url = format!("http://{}", server.server_addr());
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let join = thread::spawn(move || {
            while !thread_stop.load(Ordering::Acquire) {
                match server.recv_timeout(Duration::from_millis(100)) {
                    Ok(Some(request)) => handle_request(request, &app, &token, &startup, &profiles),
                    Ok(None) => {}
                    Err(_) => break,
                }
            }
        });
        Ok(Self {
            url,
            stop,
            join: Some(join),
        })
    }

    pub fn shutdown(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl Drop for DesktopBridge {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotificationRequest {
    title: String,
    body: String,
    #[serde(default)]
    background_only: bool,
}

#[derive(Deserialize)]
struct AutostartRequest {
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StartupRequest {
    attempt: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CancelProfileRequest {
    profile: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NotebookLmAuthWriteRequest {
    session: String,
    line: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NotebookLmAuthSessionRequest {
    session: String,
}

fn handle_request(
    mut request: Request,
    app: &AppHandle,
    token: &str,
    startup: &super::startup::StartupReadiness,
    profiles: &super::profiles::ProfileControl,
) {
    if !authenticated(&request, token) {
        respond(
            request,
            StatusCode(403),
            r#"{"ok":false,"error":"forbidden"}"#,
        );
        return;
    }
    request = match handle_profile_request(request, profiles) {
        None => return,
        Some(request) => request,
    };
    let path = request.url().split('?').next().unwrap_or(request.url());
    let result = match (request.method(), path) {
        (&Method::Get, "/v1/status") => Ok(r#"{"ok":true}"#.to_owned()),
        (&Method::Post, "/v1/runtime-ready") => read_json::<StartupRequest>(&mut request)
            .and_then(|input| startup.confirm(&input.attempt))
            .map(|()| r#"{"ok":true}"#.to_owned()),
        (&Method::Post, "/v1/show") => show_main_window(app).map(|()| r#"{"ok":true}"#.to_owned()),
        (&Method::Post, "/v1/local-agents") => super::local_agents::show_agents(app)
            .map_err(|error| error.to_string())
            .map(|()| r#"{"ok":true}"#.to_owned()),
        (&Method::Post, "/v1/notify") => read_json::<NotificationRequest>(&mut request)
            .and_then(|input| {
                if !should_notify(
                    input.background_only,
                    app.get_webview_window("main")
                        .is_some_and(|window| window.is_focused().unwrap_or(true)),
                ) {
                    return Ok(());
                }
                app.notification()
                    .builder()
                    .title(input.title)
                    .body(match input.body.as_str() {
                        "Task finished. Open Qabas to review." => super::locale::text(
                            "Task finished. Open Qabas to review.",
                            "任务已完成，打开 Qabas 查看。",
                        ),
                        "Task failed. Open Qabas to review." => super::locale::text(
                            "Task failed. Open Qabas to review.",
                            "任务执行失败，打开 Qabas 查看。",
                        ),
                        _ => &input.body,
                    })
                    .show()
                    .map_err(|error| error.to_string())
            })
            .map(|()| r#"{"ok":true}"#.to_owned()),
        (&Method::Post, "/v1/autostart") => read_json::<AutostartRequest>(&mut request)
            .and_then(|input| {
                if input.enabled {
                    app.autolaunch().enable()
                } else {
                    app.autolaunch().disable()
                }
                .map_err(|error| error.to_string())
            })
            .map(|()| r#"{"ok":true}"#.to_owned()),
        (&Method::Post, "/v1/notebooklm-auth/start") => app
            .path()
            .home_dir()
            .map_err(|_| "home-unavailable".to_owned())
            .and_then(|home| {
                app.state::<super::notebooklm::NotebookLmAuthManager>()
                    .start(&home)
            })
            .map(|value| serde_json::json!({ "ok": true, "session": value.session }).to_string()),
        (&Method::Get, "/v1/notebooklm-auth/poll") => notebooklm_poll_request(request.url())
            .and_then(|(session, cursor)| {
                app.state::<super::notebooklm::NotebookLmAuthManager>()
                    .poll(&session, cursor)
            })
            .map(|value| {
                serde_json::json!({
                    "ok": true,
                    "cursor": value.cursor,
                    "output": value.output,
                    "done": value.done,
                    "exitCode": value.exit_code,
                    "failure": value.failure,
                })
                .to_string()
            }),
        (&Method::Post, "/v1/notebooklm-auth/write") => {
            read_json::<NotebookLmAuthWriteRequest>(&mut request)
                .and_then(|input| {
                    app.state::<super::notebooklm::NotebookLmAuthManager>()
                        .write(&input.session, &input.line)
                })
                .map(|()| r#"{"ok":true}"#.to_owned())
        }
        (&Method::Post, "/v1/notebooklm-auth/cancel") => {
            read_json::<NotebookLmAuthSessionRequest>(&mut request)
                .and_then(|input| {
                    app.state::<super::notebooklm::NotebookLmAuthManager>()
                        .cancel(&input.session)
                })
                .map(|()| r#"{"ok":true}"#.to_owned())
        }
        _ => {
            respond(
                request,
                StatusCode(404),
                r#"{"ok":false,"error":"not-found"}"#,
            );
            return;
        }
    };
    respond_result(request, result);
}

fn notebooklm_poll_request(url: &str) -> Result<(String, u64), String> {
    let query = url
        .split_once('?')
        .map(|(_, query)| query)
        .unwrap_or_default();
    let mut session = None;
    let mut cursor = None;
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        match key.as_ref() {
            "session" if session.is_none() => session = Some(value.into_owned()),
            "cursor" if cursor.is_none() => cursor = value.parse::<u64>().ok(),
            _ => {}
        }
    }
    match (session, cursor) {
        (Some(session), Some(cursor)) if !session.is_empty() => Ok((session, cursor)),
        _ => Err("invalid-notebooklm-auth-poll".into()),
    }
}

/// Dispatch an already authenticated Profile request; return unrelated requests to the caller.
pub(crate) fn handle_profile_request(
    mut request: Request,
    profiles: &super::profiles::ProfileControl,
) -> Option<Request> {
    let path = request.url().split('?').next().unwrap_or(request.url());
    let result = match (request.method(), path) {
        (&Method::Get, "/v1/profile-selection") => profiles
            .selection()
            .map(|selection| serde_json::json!({ "ok": true, "selection": selection }).to_string()),
        (&Method::Post, "/v1/profile-queue") => {
            read_json::<super::profiles::Candidate>(&mut request)
                .and_then(|candidate| profiles.queue(candidate))
                .map(|()| r#"{"ok":true}"#.to_owned())
        }
        (&Method::Post, "/v1/profile-cancel") => read_json::<CancelProfileRequest>(&mut request)
            .and_then(|input| profiles.cancel(&input.profile))
            .map(|()| r#"{"ok":true}"#.to_owned()),
        _ => return Some(request),
    };
    respond_result(request, result);
    None
}

fn respond_result(request: Request, result: Result<String, String>) {
    match result {
        Ok(body) => respond(request, StatusCode(200), &body),
        Err(error) => respond(
            request,
            StatusCode(400),
            &serde_json::json!({ "ok": false, "error": error }).to_string(),
        ),
    }
}

fn authenticated(request: &Request, expected: &str) -> bool {
    request
        .headers()
        .iter()
        .find_map(|header| {
            header
                .field
                .equiv(TOKEN_HEADER)
                .then(|| header.value.as_str())
        })
        .is_some_and(|provided| {
            provided.len() == expected.len()
                && provided.as_bytes().ct_eq(expected.as_bytes()).into()
        })
}

fn should_notify(background_only: bool, focused: bool) -> bool {
    !background_only || !focused
}

fn read_json<T: for<'de> Deserialize<'de>>(request: &mut Request) -> Result<T, String> {
    let mut body = String::new();
    request
        .as_reader()
        .take(MAX_BODY_BYTES + 1)
        .read_to_string(&mut body)
        .map_err(|error| format!("Could not read request: {error}"))?;
    if body.len() as u64 > MAX_BODY_BYTES {
        return Err("Request body is too large".to_owned());
    }
    serde_json::from_str(&body).map_err(|error| format!("Invalid JSON request: {error}"))
}

fn show_main_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window is unavailable".to_owned())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

fn respond(request: Request, status: StatusCode, body: &str) {
    let content_type = Header::from_bytes("content-type", "application/json; charset=utf-8")
        .expect("static header");
    let _ = request.respond(
        Response::from_string(body)
            .with_status_code(status)
            .with_header(content_type),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_notifications_respect_focus_and_old_requests_keep_their_behavior() {
        let input: NotificationRequest =
            serde_json::from_str(r#"{"title":"Ready","body":"Done"}"#).unwrap();
        assert!(!input.background_only);
        let input: NotificationRequest =
            serde_json::from_str(r#"{"title":"Ready","body":"Done","backgroundOnly":true}"#)
                .unwrap();
        assert!(input.background_only);
        assert!(should_notify(false, true));
        assert!(should_notify(false, false));
        assert!(should_notify(true, false));
        assert!(!should_notify(true, true));
    }
}
