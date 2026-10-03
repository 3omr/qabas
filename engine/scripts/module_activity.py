"""OS-held module activity leases and a stable gate for reversible removals."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from hashlib import sha256
from pathlib import Path
from uuid import uuid4

from file_lock import exclusive_file_lock
from module_registry import ModuleConfig, ModuleConfigError


def module_gate(workspace: Path, identifier: str) -> Path:
    """Keep the admission gate outside the module, including while its directory moves."""
    return workspace / ".qabas-trash" / "module-locks" / f"{identifier}.lock"


def _gate(module: ModuleConfig) -> Path:
    root = module.paths.root
    if root.parent.name == "modules":
        return module_gate(root.parent.parent, module.module_id)
    # Direct engine callers can load an isolated module outside a workspace tree.
    key = module.module_id + "-" + sha256(str(root).encode()).hexdigest()[:12]
    return module_gate(root.parent, key)


@contextmanager
def module_activity(module: ModuleConfig) -> Iterator[None]:
    """Hold an OS lease during an engine operation; independent lectures may run concurrently."""
    gate = _gate(module)
    lease = module.paths.root / ".transcriber-cache" / "locks" / f"activity-{uuid4().hex}.lock"
    with exclusive_file_lock(gate):
        if not (module.paths.root / "module.json").is_file():
            raise ModuleConfigError(f"Module {module.module_id!r} was removed; restore it before running a job")
        holder = exclusive_file_lock(lease)
        holder.__enter__()
    try:
        yield
    finally:
        with exclusive_file_lock(gate):
            holder.__exit__(None, None, None)
            lease.unlink(missing_ok=True)


@contextmanager
def module_removal_guard(module: ModuleConfig) -> Iterator[None]:
    """Refuse an active module and exclude new engine work until the mutation completes."""
    try:
        with exclusive_file_lock(_gate(module), blocking=False):
            cache = module.paths.root / ".transcriber-cache"
            locks = [path for path in cache.rglob("*.lock") if "trash" not in path.relative_to(cache).parts]
            locks.append(module.paths.transcripts / ".transcriber-index.lock")
            # Probes close before a whole-directory rename so Windows has no open handles inside it.
            # Engine writers must first enter module_activity, whose gate remains held here.
            for path in locks:
                if path.exists():
                    with exclusive_file_lock(path, blocking=False):
                        pass
            yield
    except BlockingIOError as error:
        raise ModuleConfigError(f"Module {module.module_id!r} is busy with a running job; wait for it to finish") from error
