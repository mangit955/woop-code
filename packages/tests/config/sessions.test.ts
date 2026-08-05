import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Redirected for the whole file, never per test: restoring it in afterEach
// would point the rest of the file at the developer's real ~/.config/woopcode.
// Named with a UUID because Date.now() has millisecond resolution, so two runs
// can build the same fixture path and delete each other's files.
const previousConfigHome = process.env.XDG_CONFIG_HOME;
const configHome = mkdtempSync(join(tmpdir(), `woopcode-sessions-${crypto.randomUUID()}-`));
process.env.XDG_CONFIG_HOME = configHome;

const {
  LEGACY_SLUG,
  adoptSession,
  MAX_TITLE_CHARS,
  UNTITLED,
  createSession,
  forkSession,
  latestSession,
  listSessions,
  loadSession,
  migrateLegacyConversation,
  projectRoot,
  projectSlug,
  pruneIfDue,
  pruneSessions,
  renameSession,
  resetSessionStoreForTests,
  resolveSessionRef,
  saveSession,
  titleFromPrompt,
} = await import("../../../config/sessions");

const configDir = join(configHome, "woopcode");
const sessionsDir = join(configDir, "sessions");

function projectDir() {
  return join(sessionsDir, projectSlug(projectRoot()));
}

afterAll(() => {
  if (previousConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousConfigHome;
  }
  rmSync(configHome, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  resetSessionStoreForTests();
});

/** A session with one exchange in it, saved. */
async function seed(overrides: Record<string, unknown> = {}) {
  const session = await createSession();
  return saveSession({
    ...session,
    messages: [
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "reply" },
    ],
    ...overrides,
  });
}

describe("titleFromPrompt", () => {
  test("uses the prompt when it is short enough", () => {
    expect(titleFromPrompt("add session resume")).toBe("add session resume");
  });

  test("collapses newlines and runs of whitespace onto one line", () => {
    expect(titleFromPrompt("fix the\n\n  parser   bug")).toBe("fix the parser bug");
  });

  test("truncates long prompts to a single readable row", () => {
    const title = titleFromPrompt("x".repeat(200));
    expect(title.length).toBe(MAX_TITLE_CHARS);
    expect(title.endsWith("…")).toBe(true);
  });

  test("an empty prompt is untitled rather than blank", () => {
    expect(titleFromPrompt("   \n  ")).toBe(UNTITLED);
  });
});

describe("projectSlug", () => {
  test("keeps two directories that slugify alike apart", () => {
    // Without the path hash both of these reduce to "a-b" and two unrelated
    // projects silently share one session list.
    expect(projectSlug("/tmp/a/b")).not.toBe(projectSlug("/tmp/a-b"));
  });

  test("is stable for the same path", () => {
    expect(projectSlug("/tmp/x/y")).toBe(projectSlug("/tmp/x/y"));
  });

  test("stays readable for a normal path", () => {
    expect(projectSlug("/Users/me/woop-code")).toStartWith("woop-code-");
  });

  test("survives a path with no usable characters", () => {
    expect(projectSlug("/___")).toStartWith("project-");
  });
});

describe("resolveSessionRef", () => {
  const summaries = [
    { id: "aaaa1111-0000", name: "auth-work", title: "add auth", slug: "p" },
    { id: "bbbb2222-0000", name: null, title: "fix the parser", slug: "p" },
    { id: "bbbb3333-0000", name: null, title: "fix the lexer", slug: "p" },
  ] as any[];

  test("an exact name wins over everything else", () => {
    const result = resolveSessionRef("auth-work", summaries);
    expect(result.status).toBe("found");
    expect((result as any).session.id).toBe("aaaa1111-0000");
  });

  test("a full id resolves", () => {
    expect(resolveSessionRef("bbbb2222-0000", summaries).status).toBe("found");
  });

  test("a unique id prefix resolves", () => {
    const result = resolveSessionRef("aaaa", summaries);
    expect((result as any).session.id).toBe("aaaa1111-0000");
  });

  test("an ambiguous id prefix is reported, not guessed", () => {
    const result = resolveSessionRef("bbbb", summaries);
    expect(result.status).toBe("ambiguous");
    expect((result as any).matches).toHaveLength(2);
  });

  test("a unique title substring resolves", () => {
    const result = resolveSessionRef("parser", summaries);
    expect((result as any).session.id).toBe("bbbb2222-0000");
  });

  test("an ambiguous title substring is reported", () => {
    expect(resolveSessionRef("fix the", summaries).status).toBe("ambiguous");
  });

  test("nothing matching is none", () => {
    expect(resolveSessionRef("nope", summaries).status).toBe("none");
  });

  test("an empty ref matches nothing rather than everything", () => {
    expect(resolveSessionRef("   ", summaries).status).toBe("none");
  });
});

describe("the session store", () => {
  test("a saved session round trips", async () => {
    const saved = await seed();
    const loaded = await loadSession(saved.id);

    expect(loaded!.id).toBe(saved.id);
    expect(loaded!.messages).toHaveLength(2);
  });

  test("creating a session writes nothing until it is saved", async () => {
    await createSession();

    // An empty session file would be a resume target with nothing in it, and
    // every launch would leave one behind.
    expect(existsSync(projectDir())).toBe(false);
  });

  test("listing returns newest first", async () => {
    const older = await seed();
    await saveSession({ ...older, updated: Date.now() - 60_000 });
    const newer = await seed();

    const sessions = await listSessions();

    expect(sessions[0]!.id).toBe(newer.id);
  });

  test("the index is rebuilt when it is deleted", async () => {
    const saved = await seed();
    rmSync(join(projectDir(), "index.json"), { force: true });

    const sessions = await listSessions();

    expect(sessions.map((session) => session.id)).toContain(saved.id);
  });

  test("a corrupt index is rebuilt rather than emptying the picker", async () => {
    const saved = await seed();
    writeFileSync(join(projectDir(), "index.json"), "{not json");

    const sessions = await listSessions();

    expect(sessions.map((session) => session.id)).toContain(saved.id);
  });

  test("a corrupt session is skipped and the rest still list", async () => {
    const good = await seed();
    const bad = await seed();
    writeFileSync(join(projectDir(), `${bad.id}.json`), "{not json");
    rmSync(join(projectDir(), "index.json"), { force: true });

    const sessions = await listSessions();

    expect(sessions.map((session) => session.id)).toEqual([good.id]);
  });

  test("latestSession is what --continue reopens", async () => {
    const first = await seed();
    await saveSession({ ...first, updated: Date.now() - 60_000 });
    const second = await seed();

    expect((await latestSession())!.id).toBe(second.id);
  });

  test("renaming gives the session a resume handle", async () => {
    const saved = await seed();
    await renameSession(saved.id, "auth-work");

    const sessions = await listSessions();
    const resolution = resolveSessionRef("auth-work", sessions);

    expect((resolution as any).session.id).toBe(saved.id);
  });
});

describe("cross-project isolation", () => {
  test("a session in one project is invisible from another", async () => {
    // The regression this whole change exists to prevent: history from one
    // repository being restored into a turn taken in a different one.
    const here = await seed();

    const elsewhere = mkdtempSync(join(tmpdir(), `woopcode-other-${crypto.randomUUID()}-`));
    // A .git directory makes it a project root of its own rather than resolving
    // up into whatever contains the temp directory.
    mkdirSync(join(elsewhere, ".git"), { recursive: true });

    const theirs = await listSessions({ cwd: elsewhere });
    expect(theirs).toEqual([]);

    const ours = await listSessions();
    expect(ours.map((session) => session.id)).toContain(here.id);

    rmSync(elsewhere, { recursive: true, force: true });
  });

  test("the execution log does not cross projects either", async () => {
    const session = await createSession();
    await saveSession({
      ...session,
      messages: [{ role: "user", content: "hi" }],
      executionLog: [
        { iteration: 1, tool: "edit_file", subject: "a.ts", outcome: "written" },
      ],
    });

    const elsewhere = mkdtempSync(join(tmpdir(), `woopcode-other-${crypto.randomUUID()}-`));
    mkdirSync(join(elsewhere, ".git"), { recursive: true });

    expect(await listSessions({ cwd: elsewhere })).toEqual([]);

    rmSync(elsewhere, { recursive: true, force: true });
  });
});

describe("forking", () => {
  test("the copy is a new session carrying the same messages", async () => {
    const original = await seed();
    const copy = await forkSession(original.id, { name: "other-way" });

    expect(copy!.id).not.toBe(original.id);
    expect(copy!.forkedFrom).toBe(original.id);
    expect(copy!.name).toBe("other-way");
    expect(copy!.messages).toEqual(original.messages);
  });

  test("the original is left exactly as it was", async () => {
    const original = await seed();
    const before = await Bun.file(join(projectDir(), `${original.id}.json`)).text();

    await forkSession(original.id);

    const after = await Bun.file(join(projectDir(), `${original.id}.json`)).text();
    expect(after).toBe(before);
  });

  test("forking something that does not exist returns null", async () => {
    expect(await forkSession("no-such-id")).toBeNull();
  });
});

describe("branching across projects", () => {
  test("a session from another project can still be forked", async () => {
    // forkSession used to look only in the current project, so /branch failed
    // on exactly the sessions the picker's all-projects view exists to reach.
    const other = mkdtempSync(join(tmpdir(), `woopcode-other-${crypto.randomUUID()}-`));
    mkdirSync(join(other, ".git"), { recursive: true });

    const session = await createSession({ cwd: other });
    const saved = await saveSession({
      ...session,
      messages: [{ role: "user", content: "elsewhere" }],
    });

    const copy = await forkSession(saved.id);

    expect(copy).not.toBeNull();
    expect(copy!.forkedFrom).toBe(saved.id);
    // The copy belongs where the work continues, not where it came from.
    expect(copy!.cwd).toBe(projectRoot());

    rmSync(other, { recursive: true, force: true });
  });

  test("migrated history can be forked", async () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "conversation.json"),
      JSON.stringify([{ role: "user", content: "old" }]),
    );
    resetSessionStoreForTests();
    const imported = await migrateLegacyConversation();

    const copy = await forkSession(imported!.id, { slug: LEGACY_SLUG });

    expect(copy).not.toBeNull();
    expect(copy!.messages).toHaveLength(1);
  });
});

describe("adopting migrated history", () => {
  async function importLegacy() {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "conversation.json"),
      JSON.stringify([{ role: "user", content: "legacy work" }]),
    );
    resetSessionStoreForTests();
    return (await migrateLegacyConversation())!;
  }

  test("a session with no project moves into the one it is worked in", async () => {
    const imported = await importLegacy();
    expect(imported.cwd).toBeNull();

    const adopted = await adoptSession({
      ...imported,
      messages: [...imported.messages, { role: "assistant", content: "and more" }],
    });

    expect(adopted.cwd).toBe(projectRoot());
    expect((await listSessions()).map((session) => session.id)).toContain(imported.id);
  });

  test("it stops being listed under legacy, rather than appearing twice", async () => {
    const imported = await importLegacy();

    await adoptSession(imported);

    const all = await listSessions({ scope: "all" });
    const rows = all.filter((session) => session.id === imported.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slug).not.toBe(LEGACY_SLUG);
    expect(existsSync(join(sessionsDir, LEGACY_SLUG, `${imported.id}.json`))).toBe(false);
  });

  test("the conversation survives the move intact", async () => {
    const imported = await importLegacy();

    const adopted = await adoptSession(imported);
    const reloaded = await loadSession(adopted.id);

    expect(reloaded!.messages).toEqual(imported.messages);
    expect(reloaded!.title).toBe(imported.title);
  });

  test("adopting a session already in this project is just a save", async () => {
    const saved = await seed();

    const adopted = await adoptSession(saved);

    expect(adopted.id).toBe(saved.id);
    expect((await listSessions()).filter((s) => s.id === saved.id)).toHaveLength(1);
  });
});

describe("an index that has fallen behind the files", () => {
  test("a session missing from the index is found again", async () => {
    // Two Woopcode windows in one repository each save a session; the index is
    // a read-modify-write, so the earlier row can be lost. The file is intact,
    // and without the count check it would never be listed again.
    const first = await seed();
    const second = await seed();

    const indexPath = join(projectDir(), "index.json");
    const index = JSON.parse(await Bun.file(indexPath).text());
    index.sessions = index.sessions.filter((entry: any) => entry.id === second.id);
    writeFileSync(indexPath, JSON.stringify(index));

    const listed = (await listSessions()).map((session) => session.id);

    expect(listed).toContain(first.id);
    expect(listed).toContain(second.id);
  });

  test("an index with a stale row count is rebuilt from the files", async () => {
    const saved = await seed();
    const indexPath = join(projectDir(), "index.json");
    const index = JSON.parse(await Bun.file(indexPath).text());
    index.sessions.push({ ...index.sessions[0], id: "ghost-session" });
    writeFileSync(indexPath, JSON.stringify(index));

    const listed = (await listSessions()).map((session) => session.id);

    expect(listed).toEqual([saved.id]);
  });
});

describe("retention", () => {
  test("removes sessions past the cutoff and keeps the rest", async () => {
    const day = 24 * 60 * 60 * 1000;
    const fresh = await seed();
    const stale = await seed();
    await saveSession({ ...stale, updated: Date.now() - 40 * day });
    // saveSession stamps `updated` itself, so age it on disk afterwards.
    const stalePath = join(projectDir(), `${stale.id}.json`);
    const raw = JSON.parse(await Bun.file(stalePath).text());
    raw.updated = Date.now() - 40 * day;
    writeFileSync(stalePath, JSON.stringify(raw));
    rmSync(join(projectDir(), "index.json"), { force: true });

    const removed = await pruneSessions(30);

    expect(removed).toBe(1);
    const remaining = await listSessions();
    expect(remaining.map((session) => session.id)).toEqual([fresh.id]);
  });

  test("a session exactly at the boundary survives", async () => {
    const day = 24 * 60 * 60 * 1000;
    const saved = await seed();
    const now = Date.now();
    const path = join(projectDir(), `${saved.id}.json`);
    const raw = JSON.parse(await Bun.file(path).text());
    raw.updated = now - 30 * day;
    writeFileSync(path, JSON.stringify(raw));
    rmSync(join(projectDir(), "index.json"), { force: true });

    expect(await pruneSessions(30, now)).toBe(0);
  });

  test("a project with no sessions is left untouched", async () => {
    // pruneIfDue used to write an index to record that it had run, creating the
    // directory the lazy-creation rule exists to avoid: starting Woopcode in a
    // repository and quitting must leave nothing behind.
    const fresh = mkdtempSync(join(tmpdir(), `woopcode-fresh-${crypto.randomUUID()}-`));
    mkdirSync(join(fresh, ".git"), { recursive: true });
    const previousCwd = process.cwd();
    process.chdir(fresh);
    try {
      await pruneIfDue(30);
      expect(existsSync(join(sessionsDir, projectSlug(projectRoot())))).toBe(false);
    } finally {
      process.chdir(previousCwd);
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  test("pruning one project does not restamp another", async () => {
    // The removal counter used to be shared across every project, so a single
    // expired session anywhere rewrote the index of every project visited
    // afterwards and marked it as pruned. Needs two projects to show up: one
    // with something stale, one with nothing to do.
    const day = 24 * 60 * 60 * 1000;

    const stale = mkdtempSync(join(tmpdir(), `woopcode-stale-${crypto.randomUUID()}-`));
    mkdirSync(join(stale, ".git"), { recursive: true });
    const staleSession = await createSession({ cwd: stale });
    await saveSession({ ...staleSession, messages: [{ role: "user", content: "old" }] });
    const staleDir = join(sessionsDir, projectSlug(projectRoot(stale)));
    const stalePath = join(staleDir, `${staleSession.id}.json`);
    const staleRaw = JSON.parse(await Bun.file(stalePath).text());
    staleRaw.updated = Date.now() - 90 * day;
    writeFileSync(stalePath, JSON.stringify(staleRaw));
    rmSync(join(staleDir, "index.json"), { force: true });

    // The untouched project, whose index must come out byte-identical.
    const kept = await seed();
    const keptIndex = join(projectDir(), "index.json");
    const before = await Bun.file(keptIndex).text();

    const removed = await pruneSessions(30);

    expect(removed).toBe(1);
    expect(await Bun.file(keptIndex).text()).toBe(before);
    expect(await loadSession(kept.id)).not.toBeNull();

    rmSync(stale, { recursive: true, force: true });
  });

  test("zero days keeps everything — that is how retention is turned off", async () => {
    const saved = await seed();
    const path = join(projectDir(), `${saved.id}.json`);
    const raw = JSON.parse(await Bun.file(path).text());
    raw.updated = 0;
    writeFileSync(path, JSON.stringify(raw));

    expect(await pruneSessions(0)).toBe(0);
    expect(await loadSession(saved.id)).not.toBeNull();
  });
});

describe("migrating the pre-sessions conversation", () => {
  const legacyConversation = () => join(configDir, "conversation.json");
  const legacyLog = () => join(configDir, "execution-log.json");

  function writeLegacy(messages: unknown, log?: unknown) {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(legacyConversation(), JSON.stringify(messages));
    if (log) writeFileSync(legacyLog(), JSON.stringify(log));
  }

  test("imports the old history into the legacy bucket", async () => {
    writeLegacy(
      [
        { role: "user", content: "an old prompt" },
        { role: "assistant", content: "an old reply" },
      ],
      [{ iteration: 1, tool: "read_file", subject: "a.ts", outcome: "12 lines" }],
    );

    const imported = await migrateLegacyConversation();

    expect(imported).not.toBeNull();
    // Null cwd, not a guess: that file was shared by every repository on the
    // machine, so no project can honestly claim it.
    expect(imported!.cwd).toBeNull();
    expect(imported!.title).toBe("an old prompt");
    expect(imported!.messages).toHaveLength(2);
    expect(imported!.executionLog).toHaveLength(1);
    expect(existsSync(join(sessionsDir, LEGACY_SLUG, `${imported!.id}.json`))).toBe(true);
  });

  test("is idempotent — a second run finds nothing left to import", async () => {
    writeLegacy([{ role: "user", content: "an old prompt" }]);

    expect(await migrateLegacyConversation()).not.toBeNull();
    expect(await migrateLegacyConversation()).toBeNull();

    const legacy = await listSessions({ scope: "all" });
    expect(legacy.filter((session) => session.slug === LEGACY_SLUG)).toHaveLength(1);
  });

  test("retires the sources so they are not re-read forever", async () => {
    writeLegacy([{ role: "user", content: "hi" }], []);

    await migrateLegacyConversation();

    expect(existsSync(legacyConversation())).toBe(false);
    expect(existsSync(`${legacyConversation()}.migrated`)).toBe(true);
  });

  test("an absent file is a no-op", async () => {
    expect(await migrateLegacyConversation()).toBeNull();
  });

  test("an empty conversation imports nothing but still retires the file", async () => {
    writeLegacy([]);

    expect(await migrateLegacyConversation()).toBeNull();
    expect(existsSync(`${legacyConversation()}.migrated`)).toBe(true);
  });

  test("a corrupt file does not throw", async () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(legacyConversation(), "{not json");

    expect(await migrateLegacyConversation()).toBeNull();
  });

  test("migrated history is reachable only from the all-projects view", async () => {
    writeLegacy([{ role: "user", content: "an old prompt" }]);
    await migrateLegacyConversation();

    const scoped = await listSessions();
    expect(scoped.some((session) => session.slug === LEGACY_SLUG)).toBe(false);

    const all = await listSessions({ scope: "all" });
    expect(all.some((session) => session.slug === LEGACY_SLUG)).toBe(true);
  });
});
