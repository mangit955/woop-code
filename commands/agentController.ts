import { createProviderClient, DEFAULT_MODEL_ID } from "../providers/client";
import {
  MAX_REPO_CONTEXT_CHARS,
  buildRepositoryContext,
  getConfig,
  parseRetentionDays,
} from "../config/config";
import {
  LEGACY_SLUG,
  adoptSession,
  createSession,
  forkSession,
  latestSession,
  listSessions,
  loadSession,
  pruneIfDue,
  reloadSession,
  resolveSessionRef,
  saveSession,
  titleFromPrompt,
  UNTITLED,
  type SessionRecord,
} from "../config/sessions";
import { agentLoop } from "../runtime/loop";
import { stopAllProcesses } from "../tools/process";
import { PLAN_MODE_PROMPT } from "../config/systemPrompt";
import {
  nextSessionMode,
  sessionModeLabel,
  type SessionMode,
} from "../runtime/planMode";
import {
  EXECUTION_LOG_BUDGET_RATIO,
  recordsFrom,
  renderExecutionLog,
  type ExecutionRecord,
} from "../runtime/executionLog";
import type { AgentCallbacks, Message, TurnContext } from "../config/types";
import { store } from "../tui/src";

/**
 * Keep casual conversation out of the coding-agent path. This is deliberately
 * narrow: anything that looks like a repository task still receives tools.
 */
export function isConversationalPrompt(prompt: string) {
  const text = prompt.trim().toLowerCase().replace(/\s+/g, " ");
  if (text.length === 0 || text.length > 160) return false;

  const workSignal = /\b(add|build|change|check|code|create|debug|delete|deploy|edit|error|explain|file|fix|implement|install|investigate|look at|project|read|refactor|remove|repo|run|test|update|write)\b/;
  if (workSignal.test(text)) return false;

  return /^(hi|hey|hello|yo|thanks|thank you|okay|ok|cool|great|nice|goodbye|bye|good morning|good afternoon|good evening)[!?. ]*$/.test(text)
    || /^(how are you|who are you|what can you do|what do you do|can you help me)[!?. ]*$/.test(text);
}

/**
 * Which session a run attaches to.
 *
 * Every field is optional and the empty object is the common case: the TUI
 * continues where it left off, and `-p` starts clean. Kept optional rather than
 * required because `initialize()` is called bare from both entry points and
 * from every controller test.
 */
export interface InitializeOptions {
  /** A name, id or id prefix to resume. */
  sessionRef?: string;
  /**
   * Reopen the newest session in this project rather than starting one.
   * Defaults to true; the headless path sets it false.
   */
  continueLatest?: boolean;
  /** Branch whatever was resolved instead of writing into it. */
  fork?: boolean;
  /** Name a new session at creation, as `--name` does. */
  name?: string | null;
  /** False runs the turn without ever writing a session file. */
  persist?: boolean;
  /**
   * Open the session picker once the interface is up, for a bare `--resume`.
   * Read by the launcher, not the controller.
   */
  openPicker?: boolean;
}

export class AgentController {
  private conversation: Message[] = [];
  private repoContext = "";
  /** One line per action this session has taken; see runtime/executionLog. */
  private executionRecords: ExecutionRecord[] = [];
  private pendingAssistantText: string | null = null;
  private pendingUserMessage: Extract<Message, { role: "user" }> | null = null;
  private abortController: AbortController | null = null;
  private isRunning = false;
  private wasCancelled = false;
  private model: string;
  /**
   * Build or Plan. Owned here, beside the provider, model and cancellation, and
   * mirrored into the UI store for rendering — never read back from it.
   *
   * Not persisted: a plan mode that survived a restart would silently refuse the
   * first edit of the next session.
   */
  private sessionMode: SessionMode = "build";
  /**
   * The session this turn belongs to. Null until `initialize`, and null for the
   * lifetime of a run started with persistence off.
   */
  private session: SessionRecord | null = null;
  private persistSession = true;
  /**
   * Whether a turn has been taken since this session was loaded.
   *
   * Only used to decide when migrated history is adopted into the current
   * project: opening it to read it must not move it, but working in it should.
   */
  private sessionTouched = false;
  private readonly callbacks: AgentCallbacks;

  constructor(
    private provider: string,
    private apiKey: string,
    modelOrCallbacks: string | AgentCallbacks,
    callbacks?: AgentCallbacks,
  ) {
    this.model = typeof modelOrCallbacks === "string" ? modelOrCallbacks : DEFAULT_MODEL_ID;
    this.callbacks = typeof modelOrCallbacks === "string" ? callbacks! : modelOrCallbacks;
  }

  setModel(model: string) {
    if (this.isRunning) return false;
    this.model = model;
    return true;
  }

  /**
   * Switches the credentials used for the next turn. The provider client is
   * created per run, so changing them here is enough — without this, /provider
   * and /login only rewrite the config file while the session keeps talking to
   * the provider it started with.
   *
   * Returns false when a turn is in flight, so the caller can report that
   * instead of swapping credentials underneath a running request.
   */
  setProvider(provider: string, apiKey: string, model?: string) {
    if (this.isRunning) return false;
    this.provider = provider;
    this.apiKey = apiKey;
    if (model) this.model = model;
    return true;
  }

  getProvider() {
    return this.provider;
  }

  getSessionMode() {
    return this.sessionMode;
  }

  isPlanMode() {
    return this.sessionMode === "plan";
  }

  /**
   * Switches mode, allowed even mid-turn.
   *
   * Unlike the model and the provider, this cannot corrupt a request in flight:
   * the loop reads it once when the turn starts, so a press during a turn lands
   * on the next one. Refusing it while busy would make the key feel broken at
   * exactly the moment someone reaches for it.
   */
  setSessionMode(mode: SessionMode) {
    this.sessionMode = mode;
  }

  /** What Tab does. Returns the mode now in effect. */
  toggleSessionMode(): SessionMode {
    this.sessionMode = nextSessionMode(this.sessionMode);
    return this.sessionMode;
  }

  getModel() {
    return this.model;
  }

  async run(prompt: string) {
    if (this.isRunning) {
      return;
    }

    // Reachable once /logout clears the active provider mid-session.
    if (!this.provider || !this.apiKey) {
      this.callbacks.onError?.(
        new Error("No provider is logged in. Use /login <provider> <api-key>."),
      );
      return;
    }

    this.isRunning = true;
    this.abortController = new AbortController();
    this.wasCancelled = false;

    const userMessage: Extract<Message, { role: "user" }> = {
      role: "user",
      content: prompt,
    };

    this.conversation.push(userMessage);
    this.pendingUserMessage = userMessage;
    // The signal that this session is being worked in rather than just read.
    this.sessionTouched = true;

    const conversation = [...this.conversation];
    const conversational = isConversationalPrompt(prompt);
    this.pendingAssistantText = "";

    // The loop appends this turn's tool calls and results to `conversation`,
    // which is a copy — everything it records is discarded on return. Note
    // where this turn's records start so they can be harvested before that
    // happens, rather than threading new plumbing through the loop.
    const recordsBefore = conversation.length;

    // Update UI before starting the agent
    store.addUserMessage(prompt);
    // Opened here rather than after the first token so the footer appears
    // directly under the prompt the moment the turn starts, then travels down
    // as the turn appends tool rows and assistant text beneath it.
    store.startTurn({
      // The label the turn ran under, so a plan turn stays identifiable in
      // scrollback after the mode has been switched back.
      agent: sessionModeLabel(this.sessionMode),
      model: this.model,
      startedAt: Date.now(),
    });
    store.setStatus("Thinking...");

    let response = "";
    let agentLoopStarted = false;
    let failed = false;

    try {
      const client = createProviderClient(this.provider, this.apiKey, this.model);
      agentLoopStarted = true;
      response = await agentLoop(
        client,
        conversational ? [userMessage] : conversation,
        conversational ? "" : this.contextForTurn(),
        {
          ...this.callbacks,
          onText: (text) => {
            this.pendingAssistantText += text;
            this.callbacks.onText?.(text);
          },
          onCancel: () => {
            this.wasCancelled = true;
            this.callbacks.onCancel?.();
          },
        },
        this.abortController.signal,
        !conversational,
        // Snapshotted as the turn starts, so a Tab pressed while it runs applies
        // to the next turn rather than changing the rules underneath this one.
        { planMode: this.isPlanMode() },
      );

      const assistantText = response || this.pendingAssistantText;

      if (!this.wasCancelled && assistantText?.trim()) {
        this.conversation.push({
          role: "assistant",
          content: assistantText,
        });
      }
    } catch (error) {
      // agentLoop reports provider and tool failures itself. Client creation can
      // fail earlier (for example, when an unsupported provider is selected),
      // so surface that path to the UI as well.
      if (!agentLoopStarted) {
        this.callbacks.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      failed = true;
      await this.persist();
      throw error;
    } finally {
      // In the finally so every path harvests exactly once. A turn that failed
      // or was cancelled still did work before it stopped, and that work is
      // precisely what the next turn must not repeat.
      this.harvestExecutionRecords(conversation, recordsBefore);
      this.abortController = null;
      this.isRunning = false;
      store.finishTurn(
        this.wasCancelled ? "cancelled" : failed ? "error" : "completed",
      );
    }
    this.pendingAssistantText = null;
    if (this.wasCancelled) {
      this.removePendingUserMessage();
    } else {
      this.pendingUserMessage = null;
    }

    // Persist per turn rather than only on disposal: a crash, a killed
    // terminal or a machine losing power would otherwise discard the whole
    // session, and there is nothing else that would have written it.
    await this.persist();

    return response;
  }

  /**
   * Resolves which session this run belongs to and loads it.
   *
   * The options are optional and their defaults reproduce what Woopcode has
   * always done interactively — reopen what you were last working on — now
   * scoped to the repository you are in rather than shared by every repository
   * on the machine.
   */
  async initialize(options: InitializeOptions = {}) {
    this.persistSession = options.persist !== false;
    this.session = await this.resolveSession(options);
    this.conversation = this.session ? [...this.session.messages] : [];
    this.executionRecords = this.session ? [...this.session.executionLog] : [];
    this.repoContext = await buildRepositoryContext();

    if (this.persistSession) {
      // Retention runs at most once a day; see pruneIfDue.
      try {
        const config = await getConfig();
        await pruneIfDue(parseRetentionDays(config.retentionDays));
      } catch {
        // Housekeeping must never stop a session from starting.
      }
    }
  }

  private async resolveSession(
    options: InitializeOptions,
  ): Promise<SessionRecord | null> {
    if (!this.persistSession) return null;

    try {
      if (options.sessionRef) {
        const found = await this.findSession(options.sessionRef);
        // A ref that names nothing is the caller's error to report, not ours to
        // paper over by silently starting somewhere else.
        if (!found) throw new Error(`No session found matching "${options.sessionRef}"`);
        return options.fork ? this.mustFork(found, options.name) : found;
      }

      // Defaulted to true rather than false: continuing where you left off is
      // what Woopcode has always done and what the documentation promises. The
      // headless path opts out explicitly, because a scripted caller inheriting
      // an interactive session is a surprise it cannot see coming.
      if (options.continueLatest ?? true) {
        const latest = await latestSession();
        if (!latest) return createSession({ name: options.name });
        const record = await loadSession(latest.id, latest.slug);
        if (!record) return createSession({ name: options.name });
        return options.fork ? this.mustFork(record, options.name) : record;
      }

      return createSession({ name: options.name });
    } catch (error) {
      if (options.sessionRef) throw error;
      // Anything else — an unreadable store, a permissions problem — degrades to
      // a session that runs now and may not persist, rather than a launch that
      // fails.
      return createSession({ name: options.name });
    }
  }

  /**
   * Branches a session, or fails loudly.
   *
   * Never falls back to the original: `--fork-session` is a request *not* to
   * write into it, so quietly continuing there when the copy could not be made
   * would do the one thing the flag exists to prevent.
   */
  private async mustFork(
    source: SessionRecord,
    name?: string | null,
  ): Promise<SessionRecord> {
    const copy = await forkSession(source.id, {
      name: name ?? null,
      // Migrated history has no project of its own, so say where it lives
      // rather than letting the lookup fall back to a scan.
      slug: source.cwd ? undefined : LEGACY_SLUG,
    });
    if (!copy) {
      throw new Error(
        `Could not branch session ${source.id.slice(0, 8)}; it was left untouched.`,
      );
    }
    return copy;
  }

  /** Loads whichever session a user-supplied reference names. */
  private async findSession(ref: string): Promise<SessionRecord | null> {
    const scoped = await listSessions();
    let resolution = resolveSessionRef(ref, scoped);

    // Widened only when the current project has no answer, so a name used in
    // two repositories still resolves to the local one.
    if (resolution.status === "none") {
      resolution = resolveSessionRef(ref, await listSessions({ scope: "all" }));
    }

    if (resolution.status === "ambiguous") {
      throw new Error(
        `"${ref}" matches ${resolution.matches.length} sessions. Use the id, or /sessions to list them.`,
      );
    }
    if (resolution.status === "none") return null;

    return loadSession(resolution.session.id, resolution.session.slug);
  }

  /**
   * Keeps a one-line record of everything the turn did, before the loop's copy
   * of the conversation goes out of scope and takes the tool history with it.
   *
   * A failed or cancelled turn is harvested too: work it completed before
   * stopping is exactly what the next turn must not redo.
   */
  private harvestExecutionRecords(conversation: Message[], from: number) {
    const fresh = recordsFrom(
      conversation.slice(from),
      this.executionRecords.length + 1,
    );
    if (fresh.length === 0) return;

    this.executionRecords.push(...fresh);

    // Bounded here as well as at render time so a long session cannot grow the
    // array without limit; the render budget decides what is actually sent.
    const MAX_RETAINED = 200;
    if (this.executionRecords.length > MAX_RETAINED) {
      this.executionRecords = this.executionRecords.slice(-MAX_RETAINED);
    }
  }

  /**
   * The repository context and what this session has already done, kept apart.
   *
   * They were previously joined here and sent as one string, which made them
   * indistinguishable to the meter: the log was reported as repository context,
   * so nothing could say how much of a request was which. The loop joins them
   * now, and measures them separately.
   */
  private contextForTurn(): TurnContext {
    const budget = Math.floor(
      MAX_REPO_CONTEXT_CHARS * EXECUTION_LOG_BUDGET_RATIO,
    );

    return {
      repository: this.repoContext,
      executionLog: renderExecutionLog(this.executionRecords, budget),
      // Absent in Build mode, so an ordinary turn is assembled exactly as it was
      // before plan mode existed.
      ...(this.isPlanMode() ? { instructions: PLAN_MODE_PROMPT } : {}),
    };
  }

  async dispose() {
    // Background processes are the one thing here that outlives a turn by
    // design — a server started while answering one question has to still be
    // up for the next. This is where that ends: both the TUI's exit handler
    // and the headless path come through dispose, so a session cannot end
    // leaving a spawned process holding its port.
    //
    // Before the persist below rather than after, because persisting can fail
    // and must not be what decides whether the processes are cleaned up.
    stopAllProcesses();

    if (this.wasCancelled) {
      this.pendingAssistantText = null;
      this.removePendingUserMessage();
    } else if (this.pendingAssistantText?.trim()) {
      this.conversation.push({
        role: "assistant",
        content: this.pendingAssistantText,
      });
      this.pendingAssistantText = null;
    }

    await this.persist();
  }

  /**
   * Writes the session to disk. Failures are reported but never thrown: losing
   * history is bad, but it must not take down a turn that otherwise succeeded.
   *
   * This is also where a session first appears on disk. Nothing is written
   * until a turn has run, so opening the TUI and quitting leaves no empty
   * session behind for the picker to offer.
   */
  private async persist() {
    if (!this.persistSession || !this.session) return;

    try {
      let pending: SessionRecord = {
        ...this.session,
        title: this.sessionTitle(),
        messages: this.conversation,
        executionLog: this.executionRecords,
      };

      // Two windows open on one session — two terminals in the same repository
      // both continuing the newest one — each write the whole record, so the
      // second silently discarded the first's turn. (The single conversation
      // file behaved the same way; sessions inherited it rather than caused
      // it.) Detected by the timestamp moving underneath us, and answered by
      // branching: this turn is kept under a new id and the other window's work
      // is left exactly as it was.
      const onDisk = await reloadSession(this.session);
      if (onDisk && onDisk.updated > this.session.updated) {
        pending = {
          ...pending,
          id: crypto.randomUUID(),
          name: null,
          forkedFrom: this.session.id,
        };
        this.callbacks.onStatus?.(
          `⚠️ This conversation was changed by another Woopcode window. Continuing in a branch (${pending.id.slice(0, 8)}); nothing was overwritten.`,
        );
      }

      // Migrated history belongs to no project. Once a turn has been taken in
      // it, it belongs to this one — otherwise an hour's work would stay in the
      // `legacy` bucket, absent from the list of the very repository it
      // happened in.
      this.session =
        pending.cwd === null && this.sessionTouched
          ? await adoptSession(pending)
          : await saveSession(pending);
    } catch (error) {
      this.callbacks.onError?.(
        new Error(
          `Could not save conversation history: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  /**
   * The title to store. A name set with /rename is authoritative; otherwise the
   * first prompt names the session, and only until one exists.
   */
  private sessionTitle(): string {
    if (!this.session) return UNTITLED;
    if (this.session.title && this.session.title !== UNTITLED) {
      return this.session.title;
    }

    const firstPrompt = this.conversation.find(
      (message): message is Extract<Message, { role: "user" }> =>
        message.role === "user",
    );
    return firstPrompt ? titleFromPrompt(firstPrompt.content) : UNTITLED;
  }

  /** The session in flight, for the status line and the pickers. */
  currentSession(): SessionRecord | null {
    return this.session;
  }

  /**
   * Messages in the live conversation, which is ahead of the session record
   * between turns: the record only catches up when `persist` trims and writes.
   */
  messageCount(): number {
    return this.conversation.length;
  }

  /**
   * Points the controller at a different session and returns its messages so
   * the caller can redraw the transcript.
   *
   * Every one of these refuses while a turn is running: swapping the
   * conversation underneath a request in flight would attribute its reply to
   * the wrong session.
   */
  private async adopt(session: SessionRecord): Promise<SessionRecord> {
    this.session = session;
    this.conversation = [...session.messages];
    this.executionRecords = [...session.executionLog];
    this.pendingAssistantText = null;
    this.pendingUserMessage = null;
    // Reset with the session, or resuming migrated history after a turn in
    // another session would move it on sight rather than on use.
    this.sessionTouched = false;
    return session;
  }

  /** Starts an empty session. The current one stays on disk. */
  async newSession(): Promise<SessionRecord | null> {
    if (this.isRunning) return null;
    await this.persist();
    return this.adopt(await createSession());
  }

  /** Switches to an existing session. Throws if the reference is unusable. */
  async switchSession(ref: string): Promise<SessionRecord | null> {
    if (this.isRunning) return null;

    const found = await this.findSession(ref);
    if (!found) return null;

    await this.persist();
    return this.adopt(found);
  }

  /**
   * Copies this session and continues in the copy, leaving the original where
   * it was. Persists first, so the branch starts from what is actually on disk.
   */
  async branchSession(name?: string): Promise<SessionRecord | null> {
    if (this.isRunning || !this.session) return null;

    await this.persist();
    const copy = await forkSession(this.session.id, {
      name: name ?? null,
      // Same hint mustFork gives: migrated history has no project of its own,
      // so name where it lives rather than paying for a scan to find it.
      slug: this.session.cwd ? undefined : LEGACY_SLUG,
    });
    if (!copy) return null;

    return this.adopt(copy);
  }

  /** Gives the session a resume handle. */
  async renameSession(name: string): Promise<SessionRecord | null> {
    if (this.isRunning || !this.session) return null;

    this.session = { ...this.session, name: name.trim() || null };
    await this.persist();
    return this.session;
  }

  cancel() {
    if (!this.isRunning) {
      return;
    }

    this.wasCancelled = true;
    // Tool calls can be waiting for a UI decision. Resolve those promises
    // before aborting so Ctrl+C never leaves the agent loop suspended.
    store.clearPendingEdit();
    store.clearPendingCommand();
    store.cancelPendingQuestion();
    store.clearPendingContinuation();
    this.abortController?.abort();
  }

  isBusy() {
    return this.isRunning;
  }

  private removePendingUserMessage() {
    if (!this.pendingUserMessage) {
      return;
    }

    this.conversation = this.conversation.filter(
      (message) => message !== this.pendingUserMessage,
    );
    this.pendingUserMessage = null;
  }
}
