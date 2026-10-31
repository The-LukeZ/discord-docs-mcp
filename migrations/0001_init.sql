CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY,
  commit_sha TEXT,
  created_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('building','live','retired','failed'))
);

CREATE TABLE refresh_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  current_snapshot INTEGER,
  last_success_at TEXT,
  last_run_at TEXT,
  last_run_outcome TEXT
);
INSERT INTO refresh_state (id, current_snapshot, last_success_at, last_run_at, last_run_outcome)
VALUES (1, NULL, NULL, NULL, NULL);

CREATE TABLE file_contents (
  blob_sha TEXT PRIMARY KEY,
  content TEXT
);

CREATE TABLE snapshot_files (
  snapshot_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  blob_sha TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, path)
);

CREATE TABLE pages (
  snapshot_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  title TEXT,
  sidebar_title TEXT,
  description TEXT,
  breadcrumb TEXT,
  url TEXT,
  blob_sha TEXT,
  snippet_deps TEXT,
  problems TEXT,
  PRIMARY KEY (snapshot_id, path)
);

CREATE TABLE sections (
  snapshot_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  base_id TEXT,
  page_path TEXT NOT NULL,
  area TEXT,
  anchor TEXT,
  heading TEXT,
  heading_path TEXT,
  level INTEGER,
  part INTEGER,
  ord INTEGER,
  markdown TEXT,
  content_hash TEXT,
  PRIMARY KEY (snapshot_id, id)
);
CREATE INDEX idx_sections_page ON sections (snapshot_id, page_path);

-- Every anchor that resolves on a page (section anchor plus H4-H6 / stray manual anchors) -> containing section.
CREATE TABLE section_anchors (
  snapshot_id INTEGER NOT NULL,
  page_path TEXT NOT NULL,
  anchor TEXT NOT NULL,
  section_id TEXT NOT NULL
);
CREATE INDEX idx_section_anchors ON section_anchors (snapshot_id, page_path, anchor);

CREATE VIRTUAL TABLE sections_fts USING fts5(
  snapshot_id UNINDEXED,
  section_id UNINDEXED,
  area UNINDEXED,
  heading_path,
  title,
  body,
  tokenize = "unicode61 tokenchars '_'"
);

CREATE TABLE endpoints (
  snapshot_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  method TEXT,
  path_template TEXT,
  normalized_path TEXT,
  section_id TEXT,
  params TEXT
);
CREATE INDEX idx_endpoints_name ON endpoints (snapshot_id, lower(name));
CREATE INDEX idx_endpoints_path ON endpoints (snapshot_id, normalized_path);

CREATE TABLE objects (
  snapshot_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  section_id TEXT,
  fields TEXT
);
CREATE INDEX idx_objects_name ON objects (snapshot_id, lower(name));

CREATE TABLE fields (
  snapshot_id INTEGER NOT NULL,
  object_name TEXT NOT NULL,
  name TEXT NOT NULL,
  section_id TEXT
);
CREATE INDEX idx_fields_name ON fields (snapshot_id, lower(name));

CREATE TABLE enums (
  snapshot_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  section_id TEXT,
  owner_object TEXT,
  columns TEXT,
  rows TEXT
);
CREATE INDEX idx_enums_name ON enums (snapshot_id, lower(name));

CREATE TABLE enum_keys (
  snapshot_id INTEGER NOT NULL,
  enum_name TEXT NOT NULL,
  key TEXT NOT NULL,
  section_id TEXT
);
CREATE INDEX idx_enum_keys_key ON enum_keys (snapshot_id, lower(key));

CREATE TABLE redirects (
  snapshot_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  destination TEXT NOT NULL
);
CREATE INDEX idx_redirects_source ON redirects (snapshot_id, source);

CREATE TABLE changelog_entries (
  snapshot_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  date TEXT,
  tags TEXT,
  title TEXT,
  description TEXT,
  markdown TEXT,
  links TEXT,
  url TEXT
);
CREATE INDEX idx_changelog_date ON changelog_entries (snapshot_id, date);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  started_at TEXT,
  finished_at TEXT,
  commit_sha TEXT,
  base_snapshot INTEGER,
  new_snapshot INTEGER,
  baseline INTEGER,
  forced INTEGER,
  outcome TEXT,
  files_changed INTEGER,
  sections_added INTEGER,
  sections_modified INTEGER,
  sections_removed INTEGER,
  duration_ms INTEGER,
  problems TEXT
);

CREATE TABLE change_records (
  run_id TEXT NOT NULL,
  commit_sha TEXT,
  date TEXT,
  section_id TEXT,
  heading TEXT,
  url TEXT,
  change_type TEXT NOT NULL CHECK (change_type IN ('added','modified','removed'))
);
CREATE INDEX idx_change_records_date ON change_records (date);
