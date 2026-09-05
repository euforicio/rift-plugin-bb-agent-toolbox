// bb-plugin-bb-agent-toolbox
//
// Exposes bb SDK surfaces to agents as provider-independent agent tools via
// bb.agents.registerTool + bb.agents.contributeInstructions. These tools are
// injected into ANY provider's sessions (including the prime-agent ACP
// provider), so an agent can act inside bb: threads, projects, workspace
// files, and terminals.
//
// The transport between bb and a provider is untouched — this plugin only
// adds bb surfaces as tools. Disable or remove it and agents return to stock
// behaviour.
//
// Note: shared memory is intentionally NOT included here — the built-in
// Memory plugin already provides durable bb_memory_* agent tools (and a CLI +
// UI). This toolbox stays focused on what is otherwise missing: threads,
// workspace, and terminals.
import { type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  // ---- Settings ----------------------------------------------------------
  // Toggle whole tool groups so you can control what agents can touch. Tools
  // are registered unconditionally and gate on the CURRENT flag at execute
  // time (settings.onChange keeps `flags` live), so toggles apply without
  // reloading the plugin.
  const settings = bb.settings.define({
    enableThreads: {
      type: "boolean",
      label: "Expose thread coordination tools to agents",
      default: true,
    },
    enableWorkspace: {
      type: "boolean",
      label: "Expose workspace tools to agents",
      default: true,
    },
    enableTerminals: {
      type: "boolean",
      label: "Expose terminal tools to agents",
      default: true,
    },
  });
  const flags = { enableThreads: true, enableWorkspace: true, enableTerminals: true };
  void settings.get().then((values) => Object.assign(flags, values));
  settings.onChange((next) => Object.assign(flags, next));
  const groupDisabled = (enabled: boolean) =>
    enabled
      ? undefined
      : "This tool group is disabled in the bb-agent-toolbox plugin settings.";

  // Resolve the current thread's host + workspace root so workspace tools can
  // address the project's files with proper confinement (rootPath).
  async function resolveHost(
    threadId: string,
  ): Promise<{ hostId: string; rootPath: string | undefined; environmentId?: string }> {
    const thread = await bb.sdk.threads.get({ threadId, include: "environment" });
    const hostId = "environment" in thread ? thread.environment?.hostId : undefined;
    const rootPath = "environment" in thread ? (thread.environment?.path ?? undefined) : undefined;
    const environmentId =
      "environment" in thread ? (thread.environment?.id ?? undefined) : undefined;
    if (!hostId && !environmentId)
      throw new Error(`No environment available for thread ${threadId}`);
    return { hostId: hostId ?? "", rootPath, environmentId };
  }
  const absolutePath = (rootPath: string | undefined, rel: string): string =>
    rootPath && rel
      ? `${rootPath.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`
      : (rel || rootPath || "");

  // ---- Agent tools -------------------------------------------------------
  // Each tool: name/description, a zod parameter schema, and an execute that
  // runs server-side with bb.sdk bound and the calling thread's projectId /
  // threadId in ctx. Errors are caught and returned so the agent sees them.

  // Threads
  bb.agents.registerTool({
    name: "bbtools_threads_list",
    description:
      "List bb threads in the current project: id, title, status, provider, and activity. Use it to discover threads you can read or message.",
    parameters: z.object({
      limit: z.number().int().min(1).max(100).optional().describe("Max threads (default 25)."),
    }),
    execute: async ({ limit }, ctx) => {
      const disabled = groupDisabled(flags.enableThreads);
      if (disabled) return disabled;
      try {
        const threads = await bb.sdk.threads.list({
          projectId: ctx.projectId,
          limit: limit ?? 25,
        });
        if (threads.length === 0) return "No threads in this project.";
        return threads
          .map((t) => {
            const title = t.title ?? t.titleFallback ?? "(untitled)";
            return `${t.id}\t[${t.status}] ${title} (provider: ${t.providerId})`;
          })
          .join("\n");
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  });

  bb.agents.registerTool({
    name: "bbtools_thread_get",
    description:
      "Read a bb thread's status and its latest assistant output. Use it to check what another thread (agent) is doing or produced.",
    parameters: z.object({
      threadId: z.string().describe("The target thread id."),
    }),
    execute: async ({ threadId }) => {
      const disabled = groupDisabled(flags.enableThreads);
      if (disabled) return disabled;
      try {
        const thread = await bb.sdk.threads.get({ threadId, include: "environment" });
        const title = thread.title ?? thread.titleFallback ?? "(untitled)";
        let output = "";
        try {
          const res = await bb.sdk.threads.output({ threadId });
          if (res.output) output = `\n--- output ---\n${res.output}`;
        } catch {
          // output may be unavailable; ignore
        }
        const env =
          "environment" in thread && thread.environment?.name
            ? `\nworkspace: ${thread.environment.name}${thread.environment.path ? ` (${thread.environment.path})` : ""}`
            : "";
        return `id: ${thread.id}\nstatus: ${thread.status}\ntitle: ${title}\nprovider: ${thread.providerId}${env}${output}`;
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  });

  bb.agents.registerTool({
    name: "bbtools_thread_outline",
    description:
      "Read a compact conversation outline of a bb thread: turn-by-turn role and preview. Use it to see what another thread (e.g. a child you spawned) discussed or concluded without pulling the full transcript.",
    parameters: z.object({
      threadId: z.string().describe("The target thread id."),
    }),
    execute: async ({ threadId }) => {
      const disabled = groupDisabled(flags.enableThreads);
      if (disabled) return disabled;
      try {
        const outline = await bb.sdk.threads.conversationOutline({ threadId });
        if (outline.items.length === 0) return "No conversation yet.";
        return outline.items
          .map((item) => {
            const attachments =
              item.attachmentSummary &&
              (item.attachmentSummary.fileCount > 0 || item.attachmentSummary.imageCount > 0)
                ? ` [attachments: ${item.attachmentSummary.fileCount} files, ${item.attachmentSummary.imageCount} images]`
                : "";
            return `[${item.role}] ${item.preview.replace(/\s+/g, " ").slice(0, 400)}${attachments}`;
          })
          .join("\n");
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  });

  bb.agents.registerTool({
    name: "bbtools_thread_send",
    description:
      "Send a text message to an existing bb thread. Use it to message another agent/thread directly to coordinate work, request an update, or hand off a result.",
    parameters: z.object({
      threadId: z.string().describe("The target thread id."),
      text: z.string().min(1).describe("The message text to send."),
    }),
    execute: async ({ threadId, text }) => {
      const disabled = groupDisabled(flags.enableThreads);
      if (disabled) return disabled;
      try {
        await bb.sdk.threads.send({
          threadId,
          mode: "auto",
          input: [{ type: "text", text, mentions: [] }],
        });
        return `Sent message to thread ${threadId}.`;
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  });

  bb.agents.registerTool({
    name: "bbtools_thread_spawn",
    description:
      "Create a new bb thread (child of the current one). Use it to delegate parallel or background work to another agent thread. Defaults to the current thread's provider and environment; pass providerId/model to override.",
    parameters: z.object({
      prompt: z.string().min(1).describe("The initial prompt for the new thread."),
      providerId: z.string().optional().describe("Provider id (defaults to the current thread's)."),
      model: z.string().optional().describe("Model id (defaults to the provider default)."),
      reasoningLevel: z
        .enum(["none", "low", "medium", "high", "xhigh", "max"])
        .optional()
        .describe("Reasoning level (provider-dependent)."),
      permissionMode: z
        .enum(["accept-edits", "auto", "full"])
        .optional()
        .describe("Permission mode (default: full)."),
    }),
    execute: async ({ prompt, providerId, model, reasoningLevel, permissionMode }, ctx) => {
      const disabled = groupDisabled(flags.enableThreads);
      if (disabled) return disabled;
      try {
        const current = await bb.sdk.threads.get({ threadId: ctx.threadId });
        const environment = await (async () => {
          try {
            const { environmentId } = await resolveHost(ctx.threadId);
            return environmentId
              ? ({ type: "reuse", environmentId } as const)
              : ({ type: "project-default" } as const);
          } catch {
            return { type: "project-default" } as const;
          }
        })();
        const thread = await bb.sdk.threads.spawn({
          projectId: ctx.projectId,
          providerId: providerId ?? current.providerId,
          ...(model ? { model } : {}),
          ...(reasoningLevel ? { reasoningLevel } : {}),
          permissionMode: permissionMode ?? "full",
          environment,
          parentThreadId: ctx.threadId,
          input: [{ type: "text", text: prompt, mentions: [] }],
          origin: "plugin",
        });
        return `Spawned thread ${thread.id} in project ${ctx.projectId}.`;
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  });

  bb.agents.registerTool({
    name: "bbtools_thread_stop",
    description:
      "Stop a running bb thread (cancels its active turn). Use it to stop work you delegated to another thread, e.g. a runaway or no-longer-needed child thread.",
    parameters: z.object({
      threadId: z.string().describe("The target thread id."),
    }),
    execute: async ({ threadId }) => {
      const disabled = groupDisabled(flags.enableThreads);
      if (disabled) return disabled;
      try {
        await bb.sdk.threads.stop({ threadId });
        return `Stopped thread ${threadId}.`;
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  });

  bb.agents.registerTool({
    name: "bbtools_thread_archive",
    description:
      "Archive a bb thread (hides it from the active list; reversible via unarchive). Use it to clean up finished child threads you spawned.",
    parameters: z.object({
      threadId: z.string().describe("The target thread id."),
    }),
    execute: async ({ threadId }) => {
      const disabled = groupDisabled(flags.enableThreads);
      if (disabled) return disabled;
      try {
        await bb.sdk.threads.archive({ threadId });
        return `Archived thread ${threadId}.`;
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  });

  bb.agents.registerTool({
    name: "bbtools_thread_search",
    description:
      "Search across bb threads and messages for text. Use it to find past discussions instead of reading whole threads.",
    parameters: z.object({
      query: z.string().min(1).describe("Text to search for."),
      limitPerGroup: z.number().int().min(1).max(20).optional().describe("Results per group."),
    }),
    execute: async ({ query, limitPerGroup }) => {
      const disabled = groupDisabled(flags.enableThreads);
      if (disabled) return disabled;
      try {
        const res = await bb.sdk.threads.search({
          query,
          ...(limitPerGroup ? { limitPerGroup: String(limitPerGroup) } : {}),
        });
        const out: string[] = [];
        for (const group of [res.active, res.archived]) {
          for (const r of group.results) {
            const title = r.thread.title ?? r.thread.titleFallback ?? r.thread.id;
            for (const m of r.matches.slice(0, 3)) {
              out.push(`${title}\t${m.sourceKind}: ${m.text.slice(0, 200)}`);
            }
          }
        }
        return out.length === 0 ? "No matches." : out.join("\n");
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  });

  // Workspace
  bb.agents.registerTool({
    name: "bbtools_projects_list",
    description:
      "List bb projects with their ids and names. Use it to orient yourself across workspaces.",
    parameters: z.object({}),
    execute: async () => {
      const disabled = groupDisabled(flags.enableWorkspace);
      if (disabled) return disabled;
      try {
        const projects = await bb.sdk.projects.list({ includePersonal: true });
        if (projects.length === 0) return "No projects.";
        return projects
          .map(
            (p) =>
              `${(p as { id: string }).id}\t${(p as { name?: string }).name ?? "(unnamed)"}`,
          )
          .join("\n");
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  });

  bb.agents.registerTool({
    name: "bbtools_workspace_list",
    description:
      "List files and directories under a path in the current project's workspace. Use it to see what exists before reading files.",
    parameters: z.object({
      path: z.string().describe("Workspace-relative directory path ('' or '/' for root)."),
      includeFiles: z.boolean().optional().describe("Include files (default true)."),
      includeDirectories: z.boolean().optional().describe("Include directories (default true)."),
      limit: z.number().int().min(1).max(500).optional().describe("Max entries (default 200)."),
    }),
    execute: async ({ path, includeFiles, includeDirectories, limit }, ctx) => {
      const disabled = groupDisabled(flags.enableWorkspace);
      if (disabled) return disabled;
      try {
        const { hostId, rootPath } = await resolveHost(ctx.threadId);
        const res = await bb.sdk.files.listPaths({
          hostId,
          path: absolutePath(rootPath, path || ""),
          includeFiles: includeFiles ?? true,
          includeDirectories: includeDirectories ?? true,
          limit: limit ?? 200,
        });
        if (res.paths.length === 0) return `(empty) ${path || "/"}`;
        return res.paths
          .map((p) => `${p.kind === "directory" ? "[d]" : "   "} ${p.name}  ${p.path}`)
          .join("\n");
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  });

  bb.agents.registerTool({
    name: "bbtools_workspace_read",
    description:
      "Read a file's content from the current project's workspace. Use it to load files into context even if your own workspace access is limited.",
    parameters: z.object({
      path: z.string().describe("Workspace-relative file path."),
    }),
    execute: async ({ path }, ctx) => {
      const disabled = groupDisabled(flags.enableWorkspace);
      if (disabled) return disabled;
      try {
        const { hostId, rootPath } = await resolveHost(ctx.threadId);
        const res = await bb.sdk.files.read({
          hostId,
          path: absolutePath(rootPath, path),
          rootPath,
        });
        const content =
          res.contentEncoding === "base64"
            ? Buffer.from(res.content, "base64").toString("utf8")
            : res.content;
        return `${path} (${res.sizeBytes} bytes)\n\n${content}`;
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  });

  bb.agents.registerTool({
    name: "bbtools_workspace_write",
    description:
      "Write or overwrite a file in the current project's workspace, creating parent directories as needed. Use it to create/update files from bb context.",
    parameters: z.object({
      path: z.string().describe("Workspace-relative file path."),
      content: z.string().describe("The full file content."),
    }),
    execute: async ({ path, content }, ctx) => {
      const disabled = groupDisabled(flags.enableWorkspace);
      if (disabled) return disabled;
      try {
        const { hostId, rootPath } = await resolveHost(ctx.threadId);
        await bb.sdk.files.write({
          hostId,
          path: absolutePath(rootPath, path),
          rootPath,
          content,
          createParents: true,
        });
        return `Wrote ${path}.`;
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  });

  bb.agents.registerTool({
    name: "bbtools_workspace_mkdir",
    description:
      "Create a directory in the current project's workspace (recursively). Use it to ensure a folder exists before writing files.",
    parameters: z.object({
      path: z.string().describe("Workspace-relative directory path."),
    }),
    execute: async ({ path }, ctx) => {
      const disabled = groupDisabled(flags.enableWorkspace);
      if (disabled) return disabled;
      try {
        const { hostId, rootPath } = await resolveHost(ctx.threadId);
        await bb.sdk.files.mkdir({
          hostId,
          path: absolutePath(rootPath, path),
          rootPath,
          recursive: true,
        });
        return `Ensured directory ${path}.`;
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  });

  // Terminals
  bb.agents.registerTool({
    name: "bbtools_terminals_list",
    description:
      "List bb terminal sessions in the current thread: id, title, status, cwd. Use it to see running shells and their scope.",
    parameters: z.object({}),
    execute: async (_params, ctx) => {
      const disabled = groupDisabled(flags.enableTerminals);
      if (disabled) return disabled;
      try {
        const res = await bb.sdk.terminals.list({
          scope: { kind: "thread", threadId: ctx.threadId },
        });
        if (res.sessions.length === 0) return "No terminal sessions in this thread.";
        return res.sessions
          .map(
            (s) =>
              `${s.id}\t[${s.status}] ${s.title} (thread: ${s.threadId ?? "-"}, cwd: ${s.initialCwd})`,
          )
          .join("\n");
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  });

  bb.agents.registerTool({
    name: "bbtools_terminal_create",
    description:
      "Create a bb terminal session attached to the current thread. Use it to run a shell the user can watch live in the bb UI, or start a long-running command in a visible terminal.",
    parameters: z.object({
      title: z.string().optional().describe("Optional terminal title."),
      command: z.string().optional().describe("Initial command to run; omit for an interactive shell."),
    }),
    execute: async ({ title, command }, ctx) => {
      const disabled = groupDisabled(flags.enableTerminals);
      if (disabled) return disabled;
      try {
        const session = await bb.sdk.terminals.create({
          cols: 120,
          rows: 30,
          scope: { kind: "thread", threadId: ctx.threadId },
          ...(title ? { title } : {}),
          start: command ? { mode: "command", command } : { mode: "shell" },
        });
        return `Created terminal ${session.id}${title ? ` ("${title}")` : ""}. Use bbtools_terminal_output / bbtools_terminal_input with this id.`;
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  });

  bb.agents.registerTool({
    name: "bbtools_terminal_output",
    description:
      "Read recent output of a bb terminal session (decoded text tail). Use it after bbtools_terminal_input or bbtools_terminal_create to see what the shell printed.",
    parameters: z.object({
      terminalId: z.string().describe("Terminal session id (from bbtools_terminals_list or bbtools_terminal_create)."),
      tailBytes: z.number().int().min(200).max(200000).optional().describe("Max bytes of tail to read (default 8000)."),
    }),
    execute: async ({ terminalId, tailBytes }) => {
      const disabled = groupDisabled(flags.enableTerminals);
      if (disabled) return disabled;
      try {
        const res = await bb.sdk.terminals.output({
          terminalId,
          ...(tailBytes ? { tailBytes } : { tailBytes: 8000 }),
        });
        const text = res.chunks
          .map((c) => Buffer.from(c.dataBase64, "base64").toString("utf8"))
          .join("");
        const cleaned = text.replace(/\r\n/g, "\n").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
        return cleaned.trim().length === 0
          ? "(no output yet)"
          : `${res.truncated ? "(truncated)\n" : ""}${cleaned.trim()}`;
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  });

  bb.agents.registerTool({
    name: "bbtools_terminal_input",
    description:
      "Type text into a bb terminal session (as if the user typed it). Use it to run commands or answer prompts in a terminal the user can watch.",
    parameters: z.object({
      terminalId: z.string().describe("Terminal session id."),
      text: z.string().min(1).describe("Text to type into the terminal."),
      pressEnter: z.boolean().optional().describe("Append a newline to execute the command (default true)."),
    }),
    execute: async ({ terminalId, text, pressEnter }) => {
      const disabled = groupDisabled(flags.enableTerminals);
      if (disabled) return disabled;
      try {
        const data = text + (pressEnter ?? true ? "\n" : "");
        await bb.sdk.terminals.input({
          terminalId,
          dataBase64: Buffer.from(data, "utf8").toString("base64"),
        });
        return `Typed into terminal ${terminalId}. Use bbtools_terminal_output to read the result.`;
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  });

  bb.agents.registerTool({
    name: "bbtools_terminal_close",
    description:
      "Close a bb terminal session. Use it to clean up terminals you created.",
    parameters: z.object({
      terminalId: z.string().describe("Terminal session id."),
      force: z.boolean().optional().describe("Force-close even if a process is running (default: only close when clean)."),
    }),
    execute: async ({ terminalId, force }) => {
      const disabled = groupDisabled(flags.enableTerminals);
      if (disabled) return disabled;
      try {
        await bb.sdk.terminals.close({
          terminalId,
          mode: force ? "force" : "if-clean",
        });
        return `Closed terminal ${terminalId}.`;
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  });

  // ---- Agent instructions ------------------------------------------------
  // Appended to thread instructions whenever any of this plugin's tools are in
  // the session's tool set, so the agent knows when to reach for them. Reads
  // the live flags, so it follows settings changes for new sessions.
  bb.agents.contributeInstructions(() => {
    const lines: string[] = ["You have bb integration tools available:"];
    if (flags.enableThreads) {
      lines.push(
        "- bbtools_threads_list / bbtools_thread_get / bbtools_thread_outline / bbtools_thread_send / bbtools_thread_spawn / bbtools_thread_stop / bbtools_thread_archive / bbtools_thread_search: inspect, message, create, stop, archive, and read other bb threads directly to coordinate, delegate, or hand off work.",
      );
    }
    if (flags.enableWorkspace) {
      lines.push(
        "- bbtools_projects_list / bbtools_workspace_list / bbtools_workspace_read / bbtools_workspace_write / bbtools_workspace_mkdir: orient across projects and read/write workspace files.",
      );
    }
    if (flags.enableTerminals) {
      lines.push(
        "- bbtools_terminals_list / bbtools_terminal_create / bbtools_terminal_output / bbtools_terminal_input / bbtools_terminal_close: run and drive bb terminal sessions the user can watch live.",
      );
    }
    lines.push(
      "Prefer these over guessing when you need cross-thread state or bb project context.",
    );
    return lines.join("\n");
  });

  // ---- CLI ---------------------------------------------------------------
  bb.cli.register({
    name: "bb-agent-toolbox",
    summary: "Inspect the BB Agent Toolbox plugin's tool groups",
    commands: [
      {
        name: "status",
        summary: "Show the plugin's tool groups and their enabled state",
        usage: "bb bb-agent-toolbox status [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value) : text,
        stderr: "",
      });
      return reply(
        {
          threads: flags.enableThreads,
          workspace: flags.enableWorkspace,
          terminals: flags.enableTerminals,
          tools: [
            ...(flags.enableThreads
              ? [
                  "bbtools_threads_list",
                  "bbtools_thread_get",
                  "bbtools_thread_outline",
                  "bbtools_thread_send",
                  "bbtools_thread_spawn",
                  "bbtools_thread_stop",
                  "bbtools_thread_archive",
                  "bbtools_thread_search",
                ]
              : []),
            ...(flags.enableWorkspace
              ? ["bbtools_projects_list", "bbtools_workspace_list", "bbtools_workspace_read", "bbtools_workspace_write", "bbtools_workspace_mkdir"]
              : []),
            ...(flags.enableTerminals
              ? ["bbtools_terminals_list", "bbtools_terminal_create", "bbtools_terminal_output", "bbtools_terminal_input", "bbtools_terminal_close"]
              : []),
          ],
        },
        [
          `threads:   ${flags.enableThreads ? "on" : "off"}`,
          `workspace: ${flags.enableWorkspace ? "on" : "off"}`,
          `terminals: ${flags.enableTerminals ? "on" : "off"}`,
        ].join("\n"),
      );
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
