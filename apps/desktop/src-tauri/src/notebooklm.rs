//! Native PTY owner for the interactive NotebookLM login.

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, PtySize};
use serde::Serialize;
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
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
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
}

#[derive(Default)]
struct AuthState {
    output: Vec<u8>,
    done: bool,
    failure: Option<String>,
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
        let (state, writer, killer, child, reader) = spawn_auth(&executable, home, &directories)?;
        let id = format!("{:032x}", rand::random::<u128>());
        spawn_reader(state.clone(), reader, child);
        *slot = Some(AuthSession {
            id: id.clone(),
            state,
            writer: Arc::new(Mutex::new(writer)),
            killer: Arc::new(Mutex::new(killer)),
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
            exit_code: None,
            failure: state.failure.clone(),
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
        if session
            .state
            .lock()
            .map_err(|_| "auth state unavailable")?
            .done
        {
            return Ok(());
        }
        // The guard borrows `slot`, which the tail expression would drop
        // before the kill is evaluated. Clone the handle and let the borrow go.
        let killer = Arc::clone(&session.killer);
        drop(slot);
        // Bound rather than returned directly: a tail expression's temporaries
        // outlive the locals they borrow, and the guard borrows `killer`.
        let killed = killer
            .lock()
            .map_err(|_| "auth process unavailable")?
            .kill();
        killed.map_err(|_| "notebooklm-auth-cancel-failed".into())
    }
}

impl Drop for NotebookLmAuthManager {
    fn drop(&mut self) {
        if let Ok(slot) = self.0.get_mut() {
            if let Some(session) = slot.as_ref() {
                if let Ok(mut killer) = session.killer.lock() {
                    let _ = killer.kill();
                }
            }
        }
    }
}

fn spawn_auth(
    executable: &Path,
    home: &Path,
    directories: &[PathBuf],
) -> Result<
    (
        Arc<Mutex<AuthState>>,
        Box<dyn Write + Send>,
        Box<dyn ChildKiller + Send + Sync>,
        Box<dyn Child + Send>,
        Box<dyn Read + Send>,
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
    command.arg("auth");
    command.cwd(home);
    command.env_clear();
    for (key, value) in super::local_agents::safe_environment(directories) {
        command.env(key, value);
    }
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("could not start nlm auth: {error}"))?;
    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            let _ = child.kill();
            return Err(format!("could not read nlm auth: {error}"));
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            let _ = child.kill();
            return Err(format!("could not write nlm auth: {error}"));
        }
    };
    let killer = child.clone_killer();
    Ok((
        Arc::new(Mutex::new(AuthState::default())),
        writer,
        killer,
        child,
        reader,
    ))
}

fn spawn_reader(
    state: Arc<Mutex<AuthState>>,
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn Child + Send>,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let Ok(mut state) = state.lock() else { return };
                    if state.output.len().saturating_add(count) > MAX_AUTH_OUTPUT_BYTES {
                        state.failure = Some("notebooklm-auth-output-too-large".into());
                        let _ = child.kill();
                        break;
                    }
                    state.output.extend_from_slice(&buffer[..count]);
                }
                Err(_) => break,
            }
        }
        let _ = child.wait();
        if let Ok(mut state) = state.lock() {
            state.done = true;
        }
    });
}
