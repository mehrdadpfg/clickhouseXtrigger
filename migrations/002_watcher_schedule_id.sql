-- 002_watcher_schedule_id — remember which Trigger.dev schedule drives a watcher.
--
-- Watchers are created by users at runtime, each with its own cadence, so their
-- schedules are IMPERATIVE (schedules.create) rather than declarative. Pausing
-- and deleting one therefore has to name it: schedules.deactivate/activate/del
-- all take a scheduleId, and schedules.list() only paginates — it cannot be
-- filtered by deduplicationKey. Without this column there is no way back from a
-- watcher row to its schedule.
--
-- Nullable on purpose: the row is inserted before the schedule exists, and a
-- watcher whose schedule failed to attach is a real state the UI must survive.
--
-- Idempotent: safe to re-run.

alter table watchers
  add column if not exists schedule_id text;

-- The scheduled task resolves a watcher by its own id (the schedule's
-- externalId), so no index is needed for the hot path. This one exists for the
-- reverse lookup — "which watcher does this schedule drive?" — used when
-- reconciling orphaned schedules.
create unique index if not exists watchers_schedule_id_idx
  on watchers (schedule_id) where schedule_id is not null;
