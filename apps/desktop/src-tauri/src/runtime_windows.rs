//! Suspended runtime startup and failure-safe ownership of a Windows process tree.

use std::{
    io,
    mem::{offset_of, size_of, zeroed},
    os::windows::{
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::CommandExt,
    },
    process::{Child, Command},
    thread,
    time::Instant,
};
use windows_sys::Win32::{
    Foundation::{
        ERROR_INVALID_PARAMETER, ERROR_MORE_DATA, ERROR_NO_MORE_FILES, HANDLE,
        INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
        },
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
            JobObjectBasicAccountingInformation, JobObjectBasicProcessIdList,
            JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
            TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
            JOBOBJECT_BASIC_PROCESS_ID_LIST, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{
            OpenProcess, OpenThread, ResumeThread, WaitForSingleObject, CREATE_NEW_CONSOLE,
            CREATE_NO_WINDOW, CREATE_SUSPENDED, PROCESS_QUERY_LIMITED_INFORMATION,
            PROCESS_SYNCHRONIZE, THREAD_SUSPEND_RESUME,
        },
    },
};

use super::{POLL_INTERVAL, SHUTDOWN_GRACE};

#[derive(Debug)]
pub(crate) struct ManagedChild {
    pub(crate) child: Child,
    job: Job,
    stopped: bool,
}

impl ManagedChild {
    pub(super) fn spawn(command: &mut Command) -> Result<Self, String> {
        Self::spawn_with(command, Job::new(), resume_process)
    }

    pub(crate) fn spawn_console(command: &mut Command) -> Result<Self, String> {
        let job = Job::new()?;
        command.creation_flags(CREATE_SUSPENDED | CREATE_NEW_CONSOLE);
        let child = command.spawn().map_err(|error| error.to_string())?;
        Self::start(child, job, resume_process)
    }

    fn spawn_with(
        command: &mut Command,
        job: Result<Job, String>,
        resume: impl FnOnce(&Child) -> Result<(), String>,
    ) -> Result<Self, String> {
        let job = job?;
        command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
        let child = command.spawn().map_err(|error| error.to_string())?;
        Self::start(child, job, resume)
    }

    fn start(
        child: Child,
        job: Job,
        resume: impl FnOnce(&Child) -> Result<(), String>,
    ) -> Result<Self, String> {
        // Own the suspended process before any fallible post-spawn operation.
        let mut managed = Self {
            child,
            job,
            stopped: false,
        };
        let result = managed
            .job
            .assign(&managed.child)
            .and_then(|()| resume(&managed.child));
        if let Err(error) = result {
            return match managed.stop() {
                Ok(()) => Err(error),
                Err(cleanup) => Err(format!("{error}; runtime cleanup failed: {cleanup}")),
            };
        }
        Ok(managed)
    }

    pub(super) fn terminate(&mut self) {
        if let Err(error) = self.stop() {
            log::error!("Could not stop the Windows Harness runtime: {error}");
        }
    }

    pub(crate) fn stop(&mut self) -> Result<(), String> {
        if self.stopped {
            return Ok(());
        }
        let seal_result = self.job.seal();
        // Keep handles before termination: a zero Job count is not a wait on
        // each process's exit signal. Sealing prevents new members escaping this snapshot.
        let members = self.job.members();
        let job_result = self.job.terminate();
        // Assignment may have failed: the root is not necessarily in this Job.
        let child_result = self
            .child
            .kill()
            .and_then(|()| self.child.wait())
            .map(|_| ())
            .map_err(|error| format!("Could not reap runtime process: {error}"));
        let member_result = members.and_then(|members| wait_members(&members));
        let drain_result = self.job.wait_empty();
        let errors: Vec<_> = [
            seal_result,
            job_result,
            child_result,
            member_result,
            drain_result,
        ]
        .into_iter()
        .filter_map(Result::err)
        .collect();
        if errors.is_empty() {
            self.stopped = true;
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        self.terminate();
    }
}

#[derive(Debug)]
struct Job(OwnedHandle);

impl Job {
    fn new() -> Result<Self, String> {
        let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if raw.is_null() {
            return Err(last_error("CreateJobObjectW"));
        }
        let job = Self(unsafe { OwnedHandle::from_raw_handle(raw) });
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                job.raw(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err(last_error("SetInformationJobObject"));
        }
        Ok(job)
    }

    fn raw(&self) -> HANDLE {
        self.0.as_raw_handle()
    }

    fn assign(&self, child: &Child) -> Result<(), String> {
        if unsafe { AssignProcessToJobObject(self.raw(), child.as_raw_handle()) } == 0 {
            return Err(last_error("AssignProcessToJobObject"));
        }
        Ok(())
    }

    fn terminate(&self) -> Result<(), String> {
        if unsafe { TerminateJobObject(self.raw(), 1) } == 0 {
            return Err(last_error("TerminateJobObject"));
        }
        Ok(())
    }

    fn seal(&self) -> Result<(), String> {
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        limits.BasicLimitInformation.ActiveProcessLimit = 0;
        if unsafe {
            SetInformationJobObject(
                self.raw(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err(last_error(
                "SetInformationJobObject (close process admission)",
            ));
        }
        Ok(())
    }

    fn members(&self) -> Result<Vec<OwnedHandle>, String> {
        let deadline = Instant::now() + SHUTDOWN_GRACE;
        let mut capacity = 1;
        let ids = loop {
            let byte_length = offset_of!(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList)
                + capacity * size_of::<usize>();
            let length = u32::try_from(byte_length)
                .map_err(|_| "Windows runtime Job process list exceeds the API size limit")?;
            // The flexible array contains ULONG_PTR values and needs pointer alignment.
            let mut buffer = vec![0usize; byte_length.div_ceil(size_of::<usize>())];
            let result = unsafe {
                QueryInformationJobObject(
                    self.raw(),
                    JobObjectBasicProcessIdList,
                    buffer.as_mut_ptr().cast(),
                    length,
                    std::ptr::null_mut(),
                )
            };
            let error = io::Error::last_os_error();
            let list = unsafe { &*buffer.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>() };
            if result == 0 && error.raw_os_error() != Some(ERROR_MORE_DATA as i32) {
                return Err(format!(
                    "Could not list Windows runtime Job processes: {error}"
                ));
            }
            if result != 0 && list.NumberOfProcessIdsInList == list.NumberOfAssignedProcesses {
                let offset =
                    offset_of!(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList) / size_of::<usize>();
                break buffer[offset..offset + list.NumberOfProcessIdsInList as usize].to_vec();
            }
            if Instant::now() >= deadline {
                return Err("Windows runtime Job process list did not settle".to_owned());
            }
            capacity = (list.NumberOfAssignedProcesses as usize).max(capacity * 2);
        };
        let mut members = Vec::with_capacity(ids.len());
        for pid in ids {
            let raw = unsafe {
                OpenProcess(
                    PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                    0,
                    pid as u32,
                )
            };
            if raw.is_null() {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
                    continue; // The process exited and its PID no longer exists.
                }
                return Err(format!(
                    "Could not observe Windows runtime process {pid}: {error}"
                ));
            }
            let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
            let mut in_job = 0;
            if unsafe { IsProcessInJob(handle.as_raw_handle(), self.raw(), &mut in_job) } == 0 {
                return Err(last_error("IsProcessInJob"));
            }
            // A PID can be recycled between enumeration and OpenProcess.
            if in_job != 0 {
                members.push(handle);
            }
        }
        Ok(members)
    }

    fn wait_empty(&self) -> Result<(), String> {
        let deadline = Instant::now() + SHUTDOWN_GRACE;
        loop {
            let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
            if unsafe {
                QueryInformationJobObject(
                    self.raw(),
                    JobObjectBasicAccountingInformation,
                    (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                    size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    std::ptr::null_mut(),
                )
            } == 0
            {
                return Err(last_error("QueryInformationJobObject"));
            }
            if accounting.ActiveProcesses == 0 {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(
                    "Windows runtime Job still contains active processes after termination"
                        .to_owned(),
                );
            }
            thread::sleep(POLL_INTERVAL);
        }
    }
}

fn wait_members(members: &[OwnedHandle]) -> Result<(), String> {
    let deadline = Instant::now() + SHUTDOWN_GRACE;
    for member in members {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let timeout = remaining.as_millis().min(u32::MAX as u128 - 1) as u32;
        match unsafe { WaitForSingleObject(member.as_raw_handle(), timeout) } {
            WAIT_OBJECT_0 => {}
            WAIT_TIMEOUT => {
                return Err("Windows runtime process did not finish termination".to_owned());
            }
            _ => return Err(last_error("WaitForSingleObject")),
        }
    }
    Ok(())
}

fn last_error(api: &str) -> String {
    format!(
        "{api} failed for the Windows Harness runtime: {}",
        io::Error::last_os_error()
    )
}

fn resume_process(child: &Child) -> Result<(), String> {
    // Stable Rust does not expose Child's initial thread handle. CREATE_SUSPENDED
    // keeps that thread from executing user code while this snapshot locates it.
    let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if raw == INVALID_HANDLE_VALUE {
        return Err(last_error("CreateToolhelp32Snapshot"));
    }
    let snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut entry: THREADENTRY32 = unsafe { zeroed() };
    entry.dwSize = size_of::<THREADENTRY32>() as u32;
    if unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) } == 0 {
        return Err(last_error("Thread32First"));
    }
    loop {
        if entry.th32OwnerProcessID == child.id() {
            let raw = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if raw.is_null() {
                return Err(last_error("OpenThread"));
            }
            let thread = unsafe { OwnedHandle::from_raw_handle(raw) };
            return resume_thread(thread.as_raw_handle());
        }
        if unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) } == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_NO_MORE_FILES as i32) {
                return Err(format!(
                    "Thread32Next failed for the Windows Harness runtime: {error}"
                ));
            }
            return Err("Could not find the suspended Harness runtime thread".to_owned());
        }
    }
}

fn resume_thread(thread: HANDLE) -> Result<(), String> {
    match unsafe { ResumeThread(thread) } {
        1 => Ok(()),
        u32::MAX => Err(last_error("ResumeThread")),
        count => Err(format!(
            "Harness runtime thread had unexpected suspend count {count}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Write},
        os::windows::io::AsHandle,
        process::Stdio,
        sync::mpsc,
        time::Duration,
    };
    use windows_sys::Win32::{
        Foundation::DuplicateHandle,
        System::{
            SystemServices::{JOB_OBJECT_QUERY, JOB_OBJECT_SET_ATTRIBUTES, JOB_OBJECT_TERMINATE},
            Threading::{GetCurrentProcess, GetProcessId, TerminateProcess, PROCESS_TERMINATE},
        },
    };

    // An independent process handle both observes the outcome and cleans up a
    // deliberately broken implementation without relying on ManagedChild's Drop.
    struct ProcessProbe(OwnedHandle);

    impl ProcessProbe {
        fn child(child: &Child) -> Self {
            Self(
                child
                    .as_handle()
                    .try_clone_to_owned()
                    .expect("duplicate child handle"),
            )
        }

        fn open(pid: u32) -> Self {
            let raw = unsafe {
                OpenProcess(
                    PROCESS_SYNCHRONIZE | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                    0,
                    pid,
                )
            };
            assert!(
                !raw.is_null(),
                "could not observe descendant: {}",
                io::Error::last_os_error()
            );
            Self(unsafe { OwnedHandle::from_raw_handle(raw) })
        }

        fn state(&self) -> u32 {
            unsafe { WaitForSingleObject(self.0.as_raw_handle(), 0) }
        }

        fn id(&self) -> u32 {
            let id = unsafe { GetProcessId(self.0.as_raw_handle()) };
            assert_ne!(id, 0, "probe process id");
            id
        }
    }

    impl Drop for ProcessProbe {
        fn drop(&mut self) {
            if self.state() == WAIT_TIMEOUT {
                unsafe {
                    TerminateProcess(self.0.as_raw_handle(), 1);
                    WaitForSingleObject(self.0.as_raw_handle(), 10_000);
                }
            }
        }
    }

    fn fixture_command(kind: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().expect("test executable"));
        command
            .args([
                "--exact",
                "runtime::windows::tests::process_fixture",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env_clear()
            .env("DSH_DESKTOP_FIXTURE_KIND", kind)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(root) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", root);
        }
        command
    }

    fn suspended_child() -> Child {
        fixture_command("leaf")
            .creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW)
            .spawn()
            .expect("spawn suspended fixture")
    }

    fn descendant(managed: &mut ManagedChild) -> ProcessProbe {
        let stdout = managed
            .child
            .stdout
            .take()
            .expect("captured fixture output");
        let (sender, receiver) = mpsc::channel();
        let reader = thread::spawn(move || {
            let pid = BufReader::new(stdout)
                .lines()
                .map_while(Result::ok)
                .find_map(|line| {
                    line.strip_prefix("DSH_DESCENDANT_PID:")?
                        .parse::<u32>()
                        .ok()
                });
            let _ = sender.send(pid);
        });
        let result = receiver.recv_timeout(Duration::from_secs(20));
        if result.is_err() {
            managed.terminate();
        }
        reader.join().expect("fixture reader stopped");
        ProcessProbe::open(
            result
                .expect("fixture readiness deadline")
                .expect("descendant PID"),
        )
    }

    #[test]
    fn rejects_job_setup_before_spawning() {
        let mut command = Command::new(std::env::current_exe().unwrap().with_extension("missing"));
        let error = ManagedChild::spawn_with(
            &mut command,
            Err("job setup failed".to_owned()),
            resume_process,
        )
        .err()
        .expect("job error");
        assert_eq!(error, "job setup failed");
    }

    #[test]
    fn assignment_failure_reaps_the_suspended_process() {
        let job = Job::new().expect("test Job");
        let mut restricted = std::ptr::null_mut();
        assert_ne!(
            unsafe {
                DuplicateHandle(
                    GetCurrentProcess(),
                    job.raw(),
                    GetCurrentProcess(),
                    &mut restricted,
                    JOB_OBJECT_QUERY | JOB_OBJECT_SET_ATTRIBUTES | JOB_OBJECT_TERMINATE,
                    0,
                    0,
                )
            },
            0
        );
        let restricted = Job(unsafe { OwnedHandle::from_raw_handle(restricted) });
        let child = suspended_child();
        let probe = ProcessProbe::child(&child);
        let error = ManagedChild::start(child, restricted, resume_process)
            .err()
            .expect("assignment error");
        assert!(error.contains("AssignProcessToJobObject"), "{error}");
        assert!(!error.contains("cleanup failed"), "{error}");
        assert_eq!(
            probe.state(),
            WAIT_OBJECT_0,
            "unassigned child survived failed startup"
        );
        job.wait_empty().expect("empty test Job");
    }

    #[test]
    fn resume_failure_reaps_the_assigned_process() {
        let child = suspended_child();
        let probe = ProcessProbe::child(&child);
        let job = Job::new().expect("test Job");
        // A process handle is not a thread handle: exercise a real ResumeThread error.
        let error = ManagedChild::start(child, job, |child| resume_thread(child.as_raw_handle()))
            .err()
            .expect("resume error");
        assert!(error.contains("ResumeThread"), "{error}");
        assert!(!error.contains("cleanup failed"), "{error}");
        assert_eq!(
            probe.state(),
            WAIT_OBJECT_0,
            "assigned child survived failed startup"
        );
    }

    #[test]
    fn dropping_the_owner_stops_the_entire_job() {
        let mut managed =
            ManagedChild::spawn(&mut fixture_command("root")).expect("runtime startup");
        let root = ProcessProbe::child(&managed.child);
        let leaf = descendant(&mut managed);
        assert_eq!(root.state(), WAIT_TIMEOUT);
        assert_eq!(leaf.state(), WAIT_TIMEOUT);
        let members = managed.job.members().expect("root and descendant handles");
        let pids: Vec<_> = members
            .iter()
            .map(|member| unsafe { GetProcessId(member.as_raw_handle()) })
            .collect();
        assert!(
            pids.contains(&root.id()),
            "Job must contain the fixture root"
        );
        assert!(
            pids.contains(&leaf.id()),
            "Job must contain the fixture descendant"
        );
        drop(managed);
        assert_eq!(root.state(), WAIT_OBJECT_0, "root survived owner drop");
        assert_eq!(
            leaf.state(),
            WAIT_OBJECT_0,
            "descendant survived owner drop"
        );
        for member in &members {
            assert_eq!(
                unsafe { WaitForSingleObject(member.as_raw_handle(), 0) },
                WAIT_OBJECT_0,
                "a Job member survived owner drop"
            );
        }
    }

    #[test]
    fn termination_waits_for_descendants_after_the_root_exits() {
        let mut managed =
            ManagedChild::spawn(&mut fixture_command("root-exit")).expect("runtime startup");
        let leaf = descendant(&mut managed);
        assert!(managed.child.wait().expect("root exit").success());
        assert_eq!(leaf.state(), WAIT_TIMEOUT);
        managed.stop().expect("runtime cleanup");
        assert_eq!(
            leaf.state(),
            WAIT_OBJECT_0,
            "descendant survived termination"
        );
    }

    #[test]
    fn console_cancellation_waits_for_root_and_descendants() {
        let mut managed =
            ManagedChild::spawn_console(&mut fixture_command("root")).expect("console startup");
        let root = ProcessProbe::child(&managed.child);
        let leaf = descendant(&mut managed);
        managed.stop().expect("console cleanup");
        assert_eq!(
            root.state(),
            WAIT_OBJECT_0,
            "console root survived cancellation"
        );
        assert_eq!(
            leaf.state(),
            WAIT_OBJECT_0,
            "console descendant survived cancellation"
        );
    }

    #[test]
    fn sealed_job_rejects_new_processes_before_termination() {
        let mut managed =
            ManagedChild::spawn(&mut fixture_command("root")).expect("runtime startup");
        let leaf = descendant(&mut managed);
        {
            let mut child = suspended_child();
            let probe = ProcessProbe::child(&child);
            managed
                .job
                .assign(&child)
                .expect("unsealed Job admits another process");
            child.kill().expect("stop admission control child");
            child.wait().expect("reap admission control child");
            assert_eq!(probe.state(), WAIT_OBJECT_0);
        }
        managed.job.seal().expect("close process admission");
        {
            let mut child = suspended_child();
            let probe = ProcessProbe::child(&child);
            assert!(
                managed.job.assign(&child).is_err(),
                "sealed Job admitted a process"
            );
            let members = managed.job.members().expect("sealed Job members");
            assert!(
                !members.iter().any(|member| {
                    (unsafe { GetProcessId(member.as_raw_handle()) }) == probe.id()
                }),
                "rejected child entered the Job"
            );
            // A rejected assignment has no Job owner; the caller still owns cleanup.
            child.kill().expect("stop rejected child");
            child.wait().expect("reap rejected child");
            assert_eq!(probe.state(), WAIT_OBJECT_0);
        }
        managed.stop().expect("runtime cleanup");
        assert_eq!(leaf.state(), WAIT_OBJECT_0);
    }

    #[test]
    #[ignore = "subprocess fixture selected only by the owning lifecycle tests"]
    fn process_fixture() {
        let kind = std::env::var("DSH_DESKTOP_FIXTURE_KIND").expect("fixture mode");
        if kind == "leaf" {
            println!("\nDSH_FIXTURE_READY");
            io::stdout().flush().unwrap();
        } else {
            let mut leaf = fixture_command("leaf").spawn().expect("fixture descendant");
            let stdout = leaf.stdout.take().unwrap();
            assert!(BufReader::new(stdout)
                .lines()
                .map_while(Result::ok)
                .any(|line| line == "DSH_FIXTURE_READY"));
            println!("\nDSH_DESCENDANT_PID:{}", leaf.id());
            io::stdout().flush().unwrap();
            if kind == "root-exit" {
                std::process::exit(0);
            }
        }
        loop {
            thread::park();
        }
    }
}
