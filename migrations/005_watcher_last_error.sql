-- Why a failed watcher failed.
--
-- Until now a tick that threw wrote state = 'error' and discarded the reason,
-- so a 30s timeout and a syntax error were indistinguishable on the page — the
-- only way to tell them apart was to query the database by hand. The state says
-- something is wrong; this says what.
--
-- Cleared on the next successful tick, so it always describes the CURRENT
-- failure rather than accumulating a history nobody reads.
alter table watchers add column if not exists last_error text;
