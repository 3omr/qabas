//! Native PTY owner for the interactive NotebookLM login.

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

const AUTH_ROWS: u16 = 24;
const AUTH_COLS: u16 = 120;
const MAX_AUTH_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_AUTH_INPUT_BYTES: usize = 8192;

#[derive(Default)]
pub(crate) struct NotebookLmAuthManager(Mutex<Option<AuthSession>>);

struct AuthSession {
    id: String,
    state: Arc<Mutex<AuthState>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    control: Arc<Mutex<AuthControl>>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
}

#[derive(Default)]
struct AuthControl {
    killer: Option<Box<dyn ChildKiller + Send + Sync>>,
    cancelled: bool,
}

#[derive(Default)]
struct AuthState {
    output: Vec<u8>,
    done: bool,
    failure: Option<String>,
    exit_code: Option<i32>,
    external_console: bool,
}

#[derive(Serialize)]
pub(crate) struct NotebookLmAuthStart {
    pub(crate) session: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotebookLmAuthPoll {
    pub(crate) cursor: u64,
    pub(crate) output: String,
    pub(crate) done: bool,
    pub(crate) exit_code: Option<i32>,
    pub(crate) failure: Option<String>,
    pub(crate) external_console: bool,
}

impl NotebookLmAuthManager {
    pub(crate) fn start(&self, home: &Path) -> Result<NotebookLmAuthStart, String> {
        let mut slot = self.0.lock().map_err(|_| "auth state unavailable")?;
        if let Some(existing) = slot.as_ref() {
            let finished = existing
                .state
                .lock()
                .map_err(|_| "auth state unavailable")?
                .done;
            if !finished {
                return Err("notebooklm-auth-in-progress".into());
            }
            *slot = None;
        }
        let directories = super::local_agents::search_directories(std::env::var_os("PATH"), home);
        let executable = super::local_agents::executable("nlm", &directories)
            .ok_or_else(|| "nlm was not found on PATH".to_owned())?;
        let environment = super::local_agents::safe_environment(&directories);
        let summary = environment_summary(&environment);
        let started = Instant::now();
        let spawned = spawn_auth(&executable, &["login"], home, &environment);
        #[cfg(not(windows))]
        let (state, writer, killer, child, reader, master) = spawned?;
        #[cfg(windows)]
        let (state, writer, killer, child, reader, master) = match spawned {
            Ok(spawned) => spawned,
            Err(error) => {
                let child = spawn_console(&executable, home, &environment)
                    .map_err(|console| format!("{error}; {console}; {summary}"))?;
                let killer = child.clone_killer();
                let state = AuthState {
                    external_console: true,
                    failure: Some(format!("{error}; {summary}")),
                    ..AuthState::default()
                };
                (
                    Arc::new(Mutex::new(state)),
                    Box::new(std::io::sink()) as Box<dyn Write + Send>,
                    killer,
                    child,
                    Box::new(std::io::empty()) as Box<dyn Read + Send>,
                    None,
                )
            }
        };
        let control = Arc::new(Mutex::new(AuthControl {
            killer: Some(killer),
            cancelled: false,
        }));
        let id = format!("{:032x}", rand::random::<u128>());
        let worker = spawn_reader(
            state.clone(),
            reader,
            child,
            AuthLaunch {
                executable,
                home: home.to_path_buf(),
                environment,
                summary,
                started,
                control: control.clone(),
                master,
            },
        );
        *slot = Some(AuthSession {
            id: id.clone(),
            state,
            writer: Arc::new(Mutex::new(writer)),
            control,
            worker: Mutex::new(Some(worker)),
        });
        Ok(NotebookLmAuthStart { session: id })
    }

    pub(crate) fn poll(&self, id: &str, cursor: u64) -> Result<NotebookLmAuthPoll, String> {
        let slot = self.0.lock().map_err(|_| "auth state unavailable")?;
        let session = slot.as_ref().ok_or("notebooklm-auth-not-found")?;
        if session.id != id {
            return Err("notebooklm-auth-not-found".into());
        }
        let state = session.state.lock().map_err(|_| "auth state unavailable")?;
        let start = usize::try_from(cursor).map_err(|_| "invalid-auth-cursor")?;
        if start > state.output.len() {
            return Err("invalid-auth-cursor".into());
        }
        Ok(NotebookLmAuthPoll {
            cursor: state.output.len() as u64,
            output: String::from_utf8_lossy(&state.output[start..]).into_owned(),
            done: state.done,
            exit_code: state.exit_code,
            failure: state.failure.clone(),
            external_console: state.external_console,
        })
    }

    pub(crate) fn write(&self, id: &str, line: &str) -> Result<(), String> {
        if line.as_bytes().len() > MAX_AUTH_INPUT_BYTES {
            return Err("notebooklm-auth-input-too-large".into());
        }
        if line
            .bytes()
            .any(|byte| byte == b'\0' || byte == b'\r' || byte == b'\n')
        {
            return Err("notebooklm-auth-input-must-be-one-line".into());
        }
        let slot = self.0.lock().map_err(|_| "auth state unavailable")?;
        let session = slot.as_ref().ok_or("notebooklm-auth-not-found")?;
        if session.id != id {
            return Err("notebooklm-auth-not-found".into());
        }
        let mut writer = session
            .writer
            .lock()
            .map_err(|_| "auth writer unavailable")?;
        writer
            .write_all(format!("{line}\n").as_bytes())
            .and_then(|()| writer.flush())
            .map_err(|_| "notebooklm-auth-write-failed".into())
    }

    pub(crate) fn cancel(&self, id: &str) -> Result<(), String> {
        let slot = self.0.lock().map_err(|_| "auth state unavailable")?;
        let session = slot.as_ref().ok_or("notebooklm-auth-not-found")?;
        if session.id != id {
            return Err("notebooklm-auth-not-found".into());
        }
        stop_session(session)
    }
}

impl Drop for NotebookLmAuthManager {
    fn drop(&mut self) {
        if let Ok(slot) = self.0.get_mut() {
            if let Some(session) = slot.as_ref() {
                let _ = stop_session(session);
            }
        }
    }
}

fn spawn_auth(
    executable: &Path,
    args: &[&str],
    home: &Path,
    environment: &[(std::ffi::OsString, std::ffi::OsString)],
) -> Result<
    (
        Arc<Mutex<AuthState>>,
        Box<dyn Write + Send>,
        Box<dyn ChildKiller + Send + Sync>,
        Box<dyn Child + Send>,
        Box<dyn Read + Send>,
        Option<Box<dyn MasterPty + Send>>,
    ),
    String,
> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: AUTH_ROWS,
            cols: AUTH_COLS,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("could not allocate a terminal: {error}"))?;
    let mut command = CommandBuilder::new(executable);
    command.args(args);
    command.cwd(home);
    command.env_clear();
    for (key, value) in environment {
        command.env(key, value);
    }
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("could not start nlm login: {error}"))?;
    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("could not read nlm login: {error}"));
        }
    };
    let mut writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("could not write nlm login: {error}"));
        }
    };
    // portable-pty opens ConPTY with PSEUDOCONSOLE_INHERIT_CURSOR, so conhost requests the
    // cursor position (ESC[6n) and holds the child until the host reports one on input.
    if cfg!(windows) {
        if let Err(error) = writer.write_all(b"\x1b[1;1R").and_then(|()| writer.flush()) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("could not answer the terminal cursor query: {error}"));
        }
    }
    let killer = child.clone_killer();
    Ok((
        Arc::new(Mutex::new(AuthState::default())),
        writer,
        killer,
        child,
        reader,
        if cfg!(windows) {
            Some(pair.master)
        } else {
            None
        },
    ))
}

fn stop_session(session: &AuthSession) -> Result<(), String> {
    let mut control = session
        .control
        .lock()
        .map_err(|_| "auth process unavailable")?;
    control.cancelled = true;
    if let Some(killer) = control.killer.as_mut() {
        killer.kill().map_err(|_| "notebooklm-auth-cancel-failed")?;
    }
    drop(control);
    if let Some(worker) = session
        .worker
        .lock()
        .map_err(|_| "auth worker unavailable")?
        .take()
    {
        worker.join().map_err(|_| "notebooklm-auth-worker-failed")?;
    }
    Ok(())
}

#[cfg_attr(not(windows), allow(dead_code))]
struct AuthLaunch {
    executable: PathBuf,
    home: PathBuf,
    environment: Vec<(std::ffi::OsString, std::ffi::OsString)>,
    summary: String,
    started: Instant,
    control: Arc<Mutex<AuthControl>>,
    master: Option<Box<dyn MasterPty + Send>>,
}

fn environment_summary(environment: &[(std::ffi::OsString, std::ffi::OsString)]) -> String {
    let mut names: Vec<_> = environment
        .iter()
        .map(|(key, _)| key.to_string_lossy().into_owned())
        .collect();
    names.sort();
    let root = environment
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("SystemRoot"));
    let path = environment
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("PATH"));
    let system32 = root.zip(path).is_some_and(|((_, root), (_, path))| {
        let expected = PathBuf::from(root).join("System32");
        std::env::split_paths(path)
            .any(|entry| entry.as_os_str().eq_ignore_ascii_case(expected.as_os_str()))
    });
    format!(
        "env names: {}; PATH contains SystemRoot/System32: {system32}",
        names.join(", ")
    )
}

#[cfg(any(windows, test))]
fn needs_console(exit_code: u32, elapsed: Duration, output_bytes: usize) -> bool {
    exit_code == 0xC0000142 || (elapsed <= Duration::from_secs(5) && output_bytes == 0)
}

#[cfg(windows)]
fn spawn_console(
    executable: &Path,
    home: &Path,
    environment: &[(std::ffi::OsString, std::ffi::OsString)],
) -> Result<Box<dyn Child + Send>, String> {
    let mut command = std::process::Command::new(executable);
    command
        .arg("login")
        .current_dir(home)
        .env_clear()
        .envs(environment.iter().cloned());
    let child = super::runtime::windows::ManagedChild::spawn_console(&mut command)
        .map_err(|error| format!("could not open nlm login console: {error}"))?;
    Ok(Box::new(ConsoleChild(Arc::new(Mutex::new(child)))))
}

#[cfg(windows)]
#[derive(Clone, Debug)]
struct ConsoleChild(Arc<Mutex<super::runtime::windows::ManagedChild>>);

#[cfg(windows)]
impl ChildKiller for ConsoleChild {
    fn kill(&mut self) -> std::io::Result<()> {
        self.0
            .lock()
            .map_err(|_| std::io::Error::other("auth console unavailable"))?
            .stop()
            .map_err(std::io::Error::other)
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(self.clone())
    }
}

#[cfg(windows)]
impl Child for ConsoleChild {
    fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
        self.0
            .lock()
            .map_err(|_| std::io::Error::other("auth console unavailable"))?
            .child
            .try_wait()
            .map(|status| status.map(Into::into))
    }

    fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
        loop {
            if let Some(status) = self.try_wait()? {
                return Ok(status);
            }
            thread::sleep(Duration::from_millis(25));
        }
    }

    fn process_id(&self) -> Option<u32> {
        self.0.lock().ok().map(|child| child.child.id())
    }

    fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
        use std::os::windows::io::AsRawHandle;
        self.0.lock().ok().map(|child| AsRawHandle::as_raw_handle(&child.child))
    }
}

#[cfg(windows)]
fn wait_console(
    state: Arc<Mutex<AuthState>>,
    control: Arc<Mutex<AuthControl>>,
    mut console: Box<dyn Child + Send>,
    summary: String,
) {
    let outcome = console.wait();
    if let Ok(mut control) = control.lock() {
        control.killer = None;
    }
    drop(console);
    if let Ok(mut state) = state.lock() {
        let diagnostic = match outcome {
            Ok(status) => {
                state.exit_code = Some(status.exit_code() as i32);
                if status.success() {
                    None
                } else {
                    Some(format!(
                        "nlm login console exited 0x{:08X}; {summary}",
                        status.exit_code()
                    ))
                }
            }
            Err(error) => Some(format!(
                "could not wait for nlm login console: {error}; {summary}"
            )),
        };
        if let Some(diagnostic) = diagnostic {
            state.failure = Some(format!(
                "{}; {diagnostic}",
                state
                    .failure
                    .as_deref()
                    .unwrap_or("nlm login exited without output")
            ));
        }
        state.done = true;
    };
}

fn spawn_output_reader(
    state: Arc<Mutex<AuthState>>,
    mut reader: Box<dyn Read + Send>,
    control: Arc<Mutex<AuthControl>>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    let Ok(mut state) = state.lock() else {
                        return;
                    };
                    if state.output.len().saturating_add(count) > MAX_AUTH_OUTPUT_BYTES {
                        state.failure = Some("notebooklm-auth-output-too-large".into());
                        drop(state);
                        if let Ok(mut control) = control.lock() {
                            if let Some(killer) = control.killer.as_mut() {
                                let _ = killer.kill();
                            }
                        }
                        break;
                    }
                    state.output.extend_from_slice(&buffer[..count]);
                }
            }
        }
    })
}

fn spawn_reader(
    state: Arc<Mutex<AuthState>>,
    reader: Box<dyn Read + Send>,
    mut child: Box<dyn Child + Send>,
    launch: AuthLaunch,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let output_worker = spawn_output_reader(state.clone(), reader, launch.control.clone());
        let outcome = child.wait();
        #[cfg(windows)]
        let elapsed = launch.started.elapsed();
        // ConPTY must outlive the child, then close while its output pipe is still drained.
        drop(launch.master);
        let _ = output_worker.join();
        let Ok(mut control) = launch.control.lock() else {
            return;
        };
        control.killer = None;
        let state_owner = state;
        let Ok(mut state) = state_owner.lock() else {
            return;
        };
        match outcome {
            Ok(status) => {
                state.exit_code = Some(status.exit_code() as i32);
                if !status.success() {
                    let diagnostic = format!(
                        "nlm login exited 0x{:08X}; {}",
                        status.exit_code(),
                        launch.summary
                    );
                    state.failure = Some(match state.failure.take() {
                        Some(failure) => format!("{failure}; {diagnostic}"),
                        None => diagnostic,
                    });
                }
                #[cfg(windows)]
                if !control.cancelled
                    && !state.external_console
                    && needs_console(status.exit_code(), elapsed, state.output.len())
                {
                    if state.failure.is_none() {
                        state.failure = Some(format!(
                            "nlm login exited 0x{:08X} within five seconds without output; {}",
                            status.exit_code(),
                            launch.summary
                        ));
                    }
                    match spawn_console(&launch.executable, &launch.home, &launch.environment) {
                        Ok(console) => {
                            state.external_console = true;
                            control.killer = Some(console.clone_killer());
                            drop(state);
                            drop(control);
                            wait_console(state_owner, launch.control, console, launch.summary);
                            return;
                        }
                        Err(error) => {
                            state.failure = Some(format!(
                                "{}; {error}; {}",
                                state
                                    .failure
                                    .as_deref()
                                    .unwrap_or("nlm login exited without output"),
                                launch.summary
                            ));
                        }
                    }
                }
            }
            Err(error) => {
                state.failure = Some(format!(
                    "could not wait for nlm login: {error}; {}",
                    launch.summary
                ))
            }
        }
        state.done = true;
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_dll_failure_and_early_silent_exit_select_console() {
        for code in [-1073741502_i64, 3221225794_i64] {
            assert!(needs_console(code as u32, Duration::from_secs(20), 100));
        }
        assert!(needs_console(0, Duration::from_secs(1), 0));
        assert!(needs_console(1, Duration::from_secs(4), 0));
        assert!(needs_console(1, Duration::from_secs(5), 0));
        assert!(!needs_console(1, Duration::from_secs(6), 0));
        assert!(!needs_console(1, Duration::from_secs(1), 1));
        assert!(!needs_console(0, Duration::from_secs(8), 10));
    }

    #[test]
    fn diagnostic_summary_never_contains_environment_values() {
        let environment = vec![
            ("SystemRoot".into(), "private-root".into()),
            ("PATH".into(), "private-path".into()),
            ("TOKEN".into(), "secret-value".into()),
        ];
        let summary = environment_summary(&environment);
        assert!(summary.contains("TOKEN"));
        for value in ["private-root", "private-path", "secret-value"] {
            assert!(!summary.contains(value));
        }
    }
    #[cfg(unix)]
    #[test]
    fn pty_exit_preserves_output_and_hex_diagnostics() {
        let home = std::env::temp_dir();
        let environment = super::super::local_agents::safe_environment(&[]);
        let executable = PathBuf::from("/bin/sh");
        let (state, writer, killer, child, reader, master) = spawn_auth(
            &executable,
            &["-c", "printf 'login failed\\n'; exit 42"],
            &home,
            &environment,
        )
        .unwrap();
        let control = Arc::new(Mutex::new(AuthControl {
            killer: Some(killer),
            cancelled: false,
        }));
        let worker = spawn_reader(
            state.clone(),
            reader,
            child,
            AuthLaunch {
                executable,
                home,
                environment: environment.clone(),
                summary: environment_summary(&environment),
                started: Instant::now(),
                control: control.clone(),
                master,
            },
        );
        let manager = NotebookLmAuthManager(Mutex::new(Some(AuthSession {
            id: "fixture".into(),
            state,
            writer: Arc::new(Mutex::new(writer)),
            control,
            worker: Mutex::new(Some(worker)),
        })));
        let deadline = Instant::now() + Duration::from_secs(15);
        while !manager.poll("fixture", 0).unwrap().done && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(25));
        }
        let poll = manager.poll("fixture", 0).unwrap();
        assert!(poll.done, "PTY child did not settle");
        assert_eq!(poll.exit_code, Some(42));
        assert!(poll.output.contains("login failed"));
        assert!(poll.failure.unwrap().contains("0x0000002A; env names:"));
        manager.cancel("fixture").unwrap();
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "desktop Windows CI provides Python 3.12"]
    fn windows_hardened_pty_console_smoke() {
        let home = std::env::temp_dir();
        let directories =
            super::super::local_agents::search_directories(std::env::var_os("PATH"), &home);
        let environment = super::super::local_agents::safe_environment(&directories);
        let root = environment
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("SystemRoot"))
            .unwrap();
        let cmd = PathBuf::from(&root.1).join("System32/cmd.exe");
        for (executable, args) in [
            (cmd, vec!["/c", "exit", "0"]),
            (
                super::super::local_agents::executable("python", &directories)
                    .expect("CI Python installation"),
                vec!["-c", "print('pty smoke')"],
            ),
        ] {
            let (state, _writer, killer, child, reader, master) =
                spawn_auth(&executable, &args, &home, &environment).expect("PTY spawn");
            let control = Arc::new(Mutex::new(AuthControl {
                killer: Some(killer),
                cancelled: true,
            }));
            let worker = spawn_reader(
                state.clone(),
                reader,
                child,
                AuthLaunch {
                    executable,
                    home: home.clone(),
                    environment: environment.clone(),
                    summary: environment_summary(&environment),
                    started: Instant::now(),
                    control: control.clone(),
                    master,
                },
            );
            let deadline = Instant::now() + Duration::from_secs(15);
            while !state.lock().unwrap().done && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(25));
            }
            if !state.lock().unwrap().done {
                // portable-pty's Windows kill reports a successful TerminateProcess as an error.
                let _ = control.lock().unwrap().killer.as_mut().unwrap().kill();
                worker.join().unwrap();
                panic!("PTY smoke exceeded 15 seconds");
            }
            worker.join().unwrap();
            assert_eq!(state.lock().unwrap().exit_code, Some(0));
            assert!(state.lock().unwrap().failure.is_none());
        }
    }
}
