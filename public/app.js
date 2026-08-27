(() => {
  "use strict";

  const API = {
    meta: "/api/meta",
    projects: "/api/projects",
    runs: "/api/runs",
  };

  const ACTIVE_STATUSES = new Set(["queued", "running", "waiting_for_approval"]);
  const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

  const state = {
    meta: null,
    projects: [],
    runs: [],
    selectedRunId: null,
    selectedProjectId: "",
    currentDetail: null,
    detailRequest: 0,
    refreshing: false,
    polling: false,
    pollTimer: null,
    toastTimer: null,
    feedbackSent: new Set(),
  };

  const elements = {
    healthPill: byId("health-pill"),
    healthLabel: byId("health-label"),
    refreshButton: byId("refresh-button"),
    metaAgent: byId("meta-agent"),
    metaModel: byId("meta-model"),
    metaPolicy: byId("meta-policy"),
    metaNote: byId("meta-note"),
    footerVersion: byId("footer-version"),
    notice: byId("notice"),
    noticeText: byId("notice-text"),
    noticeDismiss: byId("notice-dismiss"),
    runForm: byId("run-form"),
    runButton: byId("run-button"),
    runButtonLabel: document.querySelector(".run-button-label"),
    promptInput: byId("prompt-input"),
    promptCount: byId("prompt-count"),
    projectSelect: byId("project-select"),
    projectsSummary: byId("projects-summary"),
    projectGrid: byId("project-grid"),
    runCount: byId("run-count"),
    runList: byId("run-list"),
    tracePanel: byId("trace-panel"),
    emptyTrace: byId("empty-trace"),
    traceContent: byId("trace-content"),
    detailStatus: byId("detail-status"),
    detailTime: byId("detail-time"),
    detailId: byId("detail-id"),
    detailTitle: byId("detail-title"),
    detailProject: byId("detail-project"),
    copyRunId: byId("copy-run-id"),
    approvalZone: byId("approval-zone"),
    approvalCount: byId("approval-count"),
    approvalList: byId("approval-list"),
    timeline: byId("timeline"),
    feedbackZone: byId("feedback-zone"),
    feedbackActions: byId("feedback-actions"),
    feedbackConfirmation: byId("feedback-confirmation"),
    toast: byId("toast"),
  };

  bindEvents();
  renderProjectSkeletons();
  renderRunSkeletons();
  loadDashboard();

  function bindEvents() {
    elements.noticeDismiss.addEventListener("click", hideNotice);
    elements.refreshButton.addEventListener("click", () => loadDashboard({ announce: true }));
    elements.runForm.addEventListener("submit", startRun);
    elements.promptInput.addEventListener("input", updatePromptCount);
    elements.promptInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        elements.runForm.requestSubmit();
      }
    });
    elements.projectSelect.addEventListener("change", () => {
      state.selectedProjectId = elements.projectSelect.value;
      renderProjects();
    });
    document.querySelectorAll("[data-prompt]").forEach((button) => {
      button.addEventListener("click", () => {
        elements.promptInput.value = button.dataset.prompt || "";
        updatePromptCount();
        elements.promptInput.focus();
      });
    });
    elements.copyRunId.addEventListener("click", copySelectedRunId);
    elements.feedbackActions.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-reaction]");
      if (button) submitFeedback(button);
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && state.runs.some((run) => ACTIVE_STATUSES.has(run.status))) {
        refreshRunsAndDetail();
      }
    });
  }

  async function loadDashboard(options = {}) {
    if (state.refreshing) return;
    state.refreshing = true;
    setRefreshBusy(true);

    const results = await Promise.allSettled([
      request(API.meta),
      request(API.projects),
      request(API.runs),
    ]);
    const errors = [];

    if (results[0].status === "fulfilled") {
      state.meta = unwrapObject(results[0].value, "meta");
      renderMeta(state.meta);
    } else {
      errors.push(`Harness metadata: ${errorText(results[0].reason)}`);
      renderMetaUnavailable();
    }

    if (results[1].status === "fulfilled") {
      state.projects = unwrapArray(results[1].value, "projects");
      renderProjectSelect();
      renderProjects();
    } else {
      errors.push(`Projects: ${errorText(results[1].reason)}`);
      renderProjectsError();
    }

    if (results[2].status === "fulfilled") {
      state.runs = sortRuns(unwrapArray(results[2].value, "runs"));
      if (state.selectedRunId && !state.runs.some((run) => run.id === state.selectedRunId)) {
        state.selectedRunId = null;
      }
      if (!state.selectedRunId && state.runs.length > 0) {
        state.selectedRunId = state.runs[0].id;
      }
      renderRuns();
      if (state.selectedRunId) await loadRunDetail(state.selectedRunId, { quiet: true });
    } else {
      errors.push(`Runs: ${errorText(results[2].reason)}`);
      renderRunsError();
    }

    setHealth(errors.length === 0 ? "online" : errors.length === 3 ? "offline" : "degraded");
    if (errors.length) showNotice(errors.join(" · "));
    else hideNotice();

    state.refreshing = false;
    setRefreshBusy(false);
    ensurePolling();
    if (options.announce) showToast(errors.length ? "Refresh finished with an API error." : "Dashboard is up to date.");
  }

  async function refreshRunsAndDetail() {
    if (state.polling || document.hidden) return;
    state.polling = true;
    try {
      const payload = await request(API.runs);
      state.runs = sortRuns(unwrapArray(payload, "runs"));
      renderRuns();
      if (state.selectedRunId) await loadRunDetail(state.selectedRunId, { quiet: true });
    } catch (_error) {
      setHealth("degraded");
    } finally {
      state.polling = false;
      ensurePolling();
    }
  }

  async function startRun(event) {
    event.preventDefault();
    const message = elements.promptInput.value.trim();
    if (!message) {
      elements.promptInput.focus();
      showToast("Add a request for the agent first.");
      return;
    }

    setComposerBusy(true);
    const body = {
      message,
      workspaceId: "local",
      actorId: "local-user",
    };
    if (state.selectedProjectId) body.projectId = state.selectedProjectId;

    try {
      const payload = await request(API.runs, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const detail = normalizeDetail(payload);
      const run = detail.run;
      if (!run || !run.id) throw new Error("The harness did not return a run ID.");

      upsertRun(run);
      state.selectedRunId = run.id;
      state.currentDetail = detail;
      elements.promptInput.value = "";
      updatePromptCount();
      renderRuns();
      renderDetail(detail);
      showToast(run.status === "waiting_for_approval" ? "Run paused for your approval." : "Run started — the trace is live.");
      ensurePolling();

      if (window.matchMedia("(max-width: 820px)").matches) {
        elements.tracePanel.scrollIntoView({ behavior: "smooth", block: "start" });
      }

      await loadRunDetail(run.id, { quiet: true });
    } catch (error) {
      showNotice(`Could not start the run: ${errorText(error)}`);
      showToast("The run could not be started.");
    } finally {
      setComposerBusy(false);
    }
  }

  async function selectRun(runId) {
    if (!runId) return;
    state.selectedRunId = runId;
    renderRuns();
    await loadRunDetail(runId);
  }

  async function loadRunDetail(runId, options = {}) {
    const requestNumber = ++state.detailRequest;
    const run = state.runs.find((item) => item.id === runId);
    if (!options.quiet) renderDetailLoading(run);

    try {
      const payload = await request(`${API.runs}/${encodeURIComponent(runId)}`);
      if (requestNumber !== state.detailRequest || state.selectedRunId !== runId) return;
      const detail = normalizeDetail(payload);
      if (!detail.run || !detail.run.id) detail.run = run || { id: runId, status: "queued", input: "Run details" };
      state.currentDetail = detail;
      upsertRun(detail.run);
      renderRuns();
      renderDetail(detail);
      ensurePolling();
    } catch (error) {
      if (requestNumber !== state.detailRequest || state.selectedRunId !== runId) return;
      if (!options.quiet) {
        renderDetailError(run, error);
        showNotice(`Could not load run ${shortId(runId)}: ${errorText(error)}`);
      }
    }
  }

  function renderMeta(meta) {
    const agent = isObject(meta.agent) ? meta.agent : {};
    const model = isObject(meta.model) ? meta.model : {};
    const agentName = firstText(agent.name, meta.agentName, agent.id, "Project Ops Agent");
    const agentVersion = firstText(agent.version, meta.agentVersion);
    elements.metaAgent.textContent = agentVersion ? `${agentName} · ${agentVersion}` : agentName;

    if (Object.keys(model).length) {
      const provider = firstText(model.provider, model.id);
      const modelName = firstText(model.model, model.name);
      elements.metaModel.textContent = [provider, modelName].filter(Boolean).join(" / ") || "Configured model";
    } else {
      elements.metaModel.textContent = firstText(meta.model, meta.modelName, "Configured model");
    }

    const policy = isObject(meta.policy) ? meta.policy : null;
    if (policy) {
      const approvalGates = Object.values(policy).filter((value) => value === "ask").length;
      elements.metaPolicy.textContent = approvalGates ? `${approvalGates} approval ${pluralize(approvalGates, "gate")}` : "Guarded execution";
    } else {
      elements.metaPolicy.textContent = firstText(meta.policy, "Guarded execution");
    }

    const tools = arrayFrom(meta.tools).length || numberFrom(meta.toolCount);
    const skills = arrayFrom(meta.skills).length || numberFrom(meta.skillCount);
    const noteParts = [];
    if (tools) noteParts.push(`${tools} ${pluralize(tools, "tool")}`);
    if (skills) noteParts.push(`${skills} ${pluralize(skills, "skill")}`);
    elements.metaNote.textContent = noteParts.length
      ? `${noteParts.join(" and ")} loaded. All writes pass through policy before execution.`
      : "Local runtime ready. Consequential actions pause at the policy boundary.";

    const version = firstText(meta.version, agentVersion);
    if (version) elements.footerVersion.textContent = version.startsWith("v") ? version : `v${version}`;
  }

  function renderMetaUnavailable() {
    elements.metaAgent.textContent = "Unavailable";
    elements.metaModel.textContent = "Unavailable";
    elements.metaPolicy.textContent = "Unknown";
    elements.metaNote.textContent = "The dashboard could not reach the local harness metadata endpoint.";
  }

  function renderProjectSelect() {
    const previous = state.selectedProjectId;
    const fragment = document.createDocumentFragment();
    fragment.append(createOption("", "All projects"));
    state.projects.forEach((project) => {
      fragment.append(createOption(String(project.id || ""), firstText(project.name, project.title, project.id, "Untitled project")));
    });
    elements.projectSelect.replaceChildren(fragment);
    if (previous && state.projects.some((project) => String(project.id) === previous)) {
      elements.projectSelect.value = previous;
    } else {
      state.selectedProjectId = "";
      elements.projectSelect.value = "";
    }
  }

  function renderProjects() {
    elements.projectGrid.setAttribute("aria-busy", "false");
    elements.projectGrid.replaceChildren();
    const activeCount = state.projects.filter((project) => {
      const status = normalizedStatus(project.status);
      return !["completed", "complete", "done", "archived", "cancelled"].includes(status);
    }).length;
    elements.projectsSummary.textContent = state.projects.length
      ? `${activeCount} active across ${state.projects.length} ${pluralize(state.projects.length, "project")}. Select one to focus the next run.`
      : "No projects are registered in this workspace yet.";

    if (!state.projects.length) {
      elements.projectGrid.append(createEmptyState("◇", "No projects yet", "Seed or connect a project to give the agent durable operating context."));
      return;
    }

    const fragment = document.createDocumentFragment();
    state.projects.forEach((project) => {
      const id = String(project.id || "");
      const name = firstText(project.name, project.title, id, "Untitled project");
      const status = normalizedStatus(project.status || "active");
      const owner = firstText(project.owner, project.assignee, "Unassigned");
      const card = createElement("button", "project-card");
      card.type = "button";
      card.setAttribute("aria-pressed", String(id === state.selectedProjectId));
      card.setAttribute("aria-label", `Use ${name} as project context`);
      if (id === state.selectedProjectId) card.classList.add("is-selected");

      const top = createElement("span", "project-card-top");
      top.append(
        createElement("span", "project-monogram", initials(name)),
        statusBadge(status, "project-status"),
      );

      const title = createElement("span", "project-card-title", name);
      const summary = createElement(
        "span",
        "project-card-summary",
        firstText(project.summary, project.description, "No project brief has been recorded yet."),
      );
      const tasks = arrayFrom(project.tasks);
      const blockedCount = tasks.filter((task) => normalizedStatus(task.status) === "blocked").length;
      const stats = createElement("span", "project-stats");
      const blockedStat = createElement("span", blockedCount ? "has-blockers" : "");
      blockedStat.append(createElement("strong", "", blockedCount), document.createTextNode(` ${pluralize(blockedCount, "blocker")}`));
      const evidenceCount = arrayFrom(project.evidence).length;
      const evidenceStat = createElement("span");
      evidenceStat.append(createElement("strong", "", evidenceCount), document.createTextNode(` ${pluralize(evidenceCount, "evidence item")}`));
      stats.append(blockedStat, evidenceStat);
      const footer = createElement("span", "project-card-footer");
      const ownerBlock = createElement("span", "project-owner");
      ownerBlock.append(createElement("span", "owner-avatar", initials(owner)), createElement("span", "", owner));
      footer.append(ownerBlock, createElement("span", "", deadlineLabel(project.dueAt || project.due_at)));
      card.append(top, title, summary, stats, footer);
      card.addEventListener("click", () => {
        state.selectedProjectId = id;
        elements.projectSelect.value = id;
        renderProjects();
        elements.promptInput.focus();
        showToast(`${name} added as the run context.`);
      });
      fragment.append(card);
    });
    elements.projectGrid.append(fragment);
  }

  function renderRuns() {
    elements.runList.setAttribute("aria-busy", "false");
    elements.runList.replaceChildren();
    elements.runCount.textContent = String(state.runs.length);
    if (!state.runs.length) {
      elements.runList.append(createEmptyState("↗", "No runs yet", "Give the agent a task above. Its full trace will appear here."));
      if (!state.selectedRunId) showEmptyTrace();
      return;
    }

    const fragment = document.createDocumentFragment();
    state.runs.forEach((run) => {
      const id = String(run.id || "");
      const status = normalizedStatus(run.status || "queued");
      const button = createElement("button", "run-item");
      button.type = "button";
      button.setAttribute("aria-label", `Inspect ${humanStatus(status)} run: ${firstText(run.input, run.message, "Untitled run")}`);
      if (id === state.selectedRunId) {
        button.classList.add("is-selected");
        button.setAttribute("aria-current", "true");
      }

      const top = createElement("span", "run-item-top");
      top.append(statusBadge(status), createElement("span", "run-item-time", relativeTime(run.createdAt || run.updatedAt)));
      const title = createElement("span", "run-item-title", firstText(run.input, run.message, run.title, "Untitled run"));
      const footer = createElement("span", "run-item-footer");
      footer.append(createElement("span", "", projectName(run.projectId)));
      const metrics = createElement("span", "run-item-metrics");
      metrics.append(
        createElement("span", "", `${numberFrom(run.step)} ${pluralize(numberFrom(run.step), "step")}`),
        createElement("span", "", `${numberFrom(run.toolCalls)} ${pluralize(numberFrom(run.toolCalls), "tool")}`),
      );
      footer.append(metrics);
      button.append(top, title, footer);
      button.addEventListener("click", () => selectRun(id));
      fragment.append(button);
    });
    elements.runList.append(fragment);
  }

  function renderDetail(detail) {
    const run = detail.run;
    if (!run) {
      showEmptyTrace();
      return;
    }

    elements.emptyTrace.hidden = true;
    elements.traceContent.hidden = false;
    elements.tracePanel.setAttribute("aria-busy", "false");
    const status = normalizedStatus(run.status || "queued");
    applyStatusBadge(elements.detailStatus, status);
    elements.detailTime.textContent = relativeTime(run.createdAt || run.updatedAt);
    elements.detailId.textContent = shortId(run.id);
    elements.detailTitle.textContent = firstText(run.input, run.message, run.title, "Untitled run");
    elements.detailProject.textContent = projectName(run.projectId);

    renderApprovals(detail.approvals, detail.invocations);
    renderTimeline(run, detail.events);
    renderFeedback(run, detail.feedback);
  }

  function renderDetailLoading(run) {
    elements.emptyTrace.hidden = true;
    elements.traceContent.hidden = false;
    elements.tracePanel.setAttribute("aria-busy", "true");
    const status = normalizedStatus(run && run.status ? run.status : "queued");
    applyStatusBadge(elements.detailStatus, status);
    elements.detailTime.textContent = run ? relativeTime(run.createdAt || run.updatedAt) : "Loading";
    elements.detailId.textContent = run ? shortId(run.id) : "—";
    elements.detailTitle.textContent = run ? firstText(run.input, run.message, "Loading run…") : "Loading run…";
    elements.detailProject.textContent = run ? projectName(run.projectId) : "—";
    elements.approvalZone.hidden = true;
    elements.feedbackZone.hidden = true;
    elements.timeline.replaceChildren(createTimelineItem({
      kind: "live",
      symbol: "··",
      title: "Loading trace",
      body: "Retrieving the chronological event stream…",
      createdAt: new Date().toISOString(),
    }));
  }

  function renderDetailError(run, error) {
    renderDetailLoading(run);
    elements.tracePanel.setAttribute("aria-busy", "false");
    elements.timeline.replaceChildren(createTimelineItem({
      kind: "error",
      symbol: "!",
      title: "Trace unavailable",
      body: errorText(error),
      createdAt: new Date().toISOString(),
    }));
  }

  function renderApprovals(approvals, invocations) {
    const records = arrayFrom(approvals);
    elements.approvalList.replaceChildren();
    if (!records.length) {
      elements.approvalZone.hidden = true;
      return;
    }

    elements.approvalZone.hidden = false;
    const pendingCount = records.filter((approval) => normalizedStatus(approval.status) === "pending").length;
    elements.approvalCount.textContent = pendingCount
      ? `${pendingCount} ${pluralize(pendingCount, "approval")} pending`
      : "Checkpoint resolved";

    const fragment = document.createDocumentFragment();
    records.forEach((approval) => {
      const invocation = findInvocation(approval, invocations);
      const status = normalizedStatus(approval.status || "pending");
      const toolName = firstText(approval.toolName, approval.tool_name, invocation && invocation.toolName, "unknown_tool");
      const args = approval.arguments !== undefined
        ? approval.arguments
        : approval.args !== undefined
          ? approval.args
          : invocation && invocation.arguments !== undefined
            ? invocation.arguments
            : {};
      const card = createElement("article", "approval-card");
      const top = createElement("div", "approval-card-top");
      top.append(createElement("span", "approval-tool", toolName), createElement("span", "approval-state", humanStatus(status)));
      const label = createElement("label", "", "Exact tool arguments");
      const pre = createElement("pre", "approval-arguments", formatArguments(args));
      card.append(top, label, pre);

      if (status === "pending") {
        const actions = createElement("div", "approval-actions");
        const reject = createElement("button", "reject-button", "Reject");
        const approve = createElement("button", "approve-button", "Approve & continue");
        reject.type = "button";
        approve.type = "button";
        reject.addEventListener("click", () => resolveApproval(approval, "reject", [reject, approve]));
        approve.addEventListener("click", () => resolveApproval(approval, "approve", [reject, approve]));
        actions.append(reject, approve);
        card.append(actions);
      }
      fragment.append(card);
    });
    elements.approvalList.append(fragment);
  }

  async function resolveApproval(approval, decision, buttons) {
    if (!approval || !approval.id) return;
    buttons.forEach((button) => { button.disabled = true; });
    try {
      await request(`/api/approvals/${encodeURIComponent(approval.id)}`, {
        method: "POST",
        body: JSON.stringify({ decision, actorId: "local-user" }),
      });
      showToast(decision === "approve" ? "Approved. The harness may continue." : "Rejected. The tool will not run.");
      await Promise.all([
        loadRunDetail(approval.runId || state.selectedRunId, { quiet: true }),
        refreshRunListOnly(),
      ]);
      ensurePolling();
    } catch (error) {
      buttons.forEach((button) => { button.disabled = false; });
      showNotice(`Could not ${decision} this action: ${errorText(error)}`);
      showToast("Approval decision was not saved.");
    }
  }

  function renderTimeline(run, events) {
    const items = [];
    items.push({
      kind: "input",
      symbol: "IN",
      title: "Request received",
      body: firstText(run.input, run.message, "No request text recorded."),
      createdAt: run.createdAt,
    });

    const orderedEvents = arrayFrom(events).slice().sort((left, right) => {
      const sequenceDelta = numberFrom(left.seq) - numberFrom(right.seq);
      if (sequenceDelta !== 0) return sequenceDelta;
      return dateValue(left.createdAt) - dateValue(right.createdAt);
    });
    orderedEvents.forEach((event) => {
      const type = firstText(event.type, "event");
      items.push({
        kind: eventKind(type),
        symbol: eventSymbol(type),
        title: eventTitle(type),
        body: summarizeEvent(type, event.data),
        createdAt: event.createdAt,
        eventType: type,
        payload: event.data,
        seq: event.seq,
      });
    });

    if (!orderedEvents.length && ACTIVE_STATUSES.has(normalizedStatus(run.status))) {
      items.push({
        kind: "live",
        symbol: "··",
        title: normalizedStatus(run.status) === "waiting_for_approval" ? "Waiting at policy boundary" : "Agent is working",
        body: normalizedStatus(run.status) === "waiting_for_approval"
          ? "Review the exact action above to continue or reject it."
          : "New events will appear here as the harness advances.",
        createdAt: run.updatedAt || run.createdAt,
      });
    }

    if (run.output) {
      items.push({
        kind: "output",
        symbol: "✓",
        title: "Final response",
        body: String(run.output),
        createdAt: run.finishedAt || run.updatedAt,
      });
    }
    if (run.error) {
      items.push({
        kind: "error",
        symbol: "!",
        title: "Run failed",
        body: String(run.error),
        createdAt: run.finishedAt || run.updatedAt,
      });
    }

    const fragment = document.createDocumentFragment();
    items.forEach((item) => fragment.append(createTimelineItem(item)));
    elements.timeline.replaceChildren(fragment);
  }

  function createTimelineItem(item) {
    const article = createElement("article", `timeline-item kind-${safeSlug(item.kind || "event")}`);
    const node = createElement("span", "timeline-node", item.symbol || "·");
    node.setAttribute("aria-hidden", "true");
    const content = createElement("div", "timeline-content");
    content.append(
      createElement("div", "timeline-title", item.title || "Harness event"),
      createElement("p", "timeline-body", item.body || "Event recorded."),
    );
    if (item.payload !== undefined) {
      const details = createElement("details", "event-details");
      const suffix = item.seq !== undefined ? ` · #${item.seq}` : "";
      details.append(
        createElement("summary", "", `Inspect ${item.eventType || "event"}${suffix}`),
        createElement("pre", "event-payload", formatJson(item.payload)),
      );
      content.append(details);
    }
    article.append(node, content, createElement("time", "timeline-time", formatClock(item.createdAt)));
    return article;
  }

  function renderFeedback(run, feedback) {
    const terminal = TERMINAL_STATUSES.has(normalizedStatus(run.status));
    elements.feedbackZone.hidden = !terminal;
    if (!terminal) return;

    const existing = arrayFrom(feedback).some((record) => !record.actorId || record.actorId === "local-user");
    const sent = existing || state.feedbackSent.has(run.id);
    elements.feedbackActions.hidden = sent;
    elements.feedbackConfirmation.hidden = !sent;
    elements.feedbackConfirmation.textContent = sent ? "Signal saved — thank you." : "";
    elements.feedbackActions.querySelectorAll("button").forEach((button) => { button.disabled = false; });
  }

  async function submitFeedback(button) {
    const runId = state.selectedRunId;
    if (!runId || state.feedbackSent.has(runId)) return;
    const score = Number(button.dataset.score || 0);
    const dimension = button.dataset.dimension || "helpfulness";
    const actions = Array.from(elements.feedbackActions.querySelectorAll("button"));
    actions.forEach((action) => { action.disabled = true; });
    try {
      await request(`${API.runs}/${encodeURIComponent(runId)}/feedback`, {
        method: "POST",
        body: JSON.stringify({
          reaction: button.dataset.reaction,
          score,
          dimensions: { [dimension]: score },
        }),
      });
      state.feedbackSent.add(runId);
      elements.feedbackActions.hidden = true;
      elements.feedbackConfirmation.textContent = "Signal saved — thank you.";
      elements.feedbackConfirmation.hidden = false;
      showToast("Preference signal saved with this run.");
    } catch (error) {
      actions.forEach((action) => { action.disabled = false; });
      showNotice(`Could not save feedback: ${errorText(error)}`);
      showToast("Feedback was not saved.");
    }
  }

  async function refreshRunListOnly() {
    try {
      const payload = await request(API.runs);
      state.runs = sortRuns(unwrapArray(payload, "runs"));
      renderRuns();
    } catch (_error) {
      setHealth("degraded");
    }
  }

  async function copySelectedRunId() {
    if (!state.selectedRunId) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(state.selectedRunId);
      } else {
        const input = createElement("textarea", "visually-hidden", state.selectedRunId);
        document.body.append(input);
        input.select();
        document.execCommand("copy");
        input.remove();
      }
      showToast("Run ID copied.");
    } catch (_error) {
      showToast(`Run ID: ${state.selectedRunId}`);
    }
  }

  function ensurePolling() {
    const shouldPoll = state.runs.some((run) => ACTIVE_STATUSES.has(normalizedStatus(run.status)));
    if (!shouldPoll) {
      if (state.pollTimer) window.clearInterval(state.pollTimer);
      state.pollTimer = null;
      return;
    }
    if (!state.pollTimer) {
      state.pollTimer = window.setInterval(refreshRunsAndDetail, 4000);
    }
  }

  function setHealth(mode) {
    elements.healthPill.classList.remove("is-online", "is-offline");
    if (mode === "online") {
      elements.healthPill.classList.add("is-online");
      elements.healthLabel.textContent = "Operational";
    } else if (mode === "degraded") {
      elements.healthLabel.textContent = "Degraded";
    } else {
      elements.healthPill.classList.add("is-offline");
      elements.healthLabel.textContent = "Offline";
    }
  }

  function setComposerBusy(busy) {
    elements.runButton.disabled = busy;
    elements.promptInput.disabled = busy;
    elements.projectSelect.disabled = busy;
    elements.runButton.classList.toggle("is-loading", busy);
    elements.runButtonLabel.textContent = busy ? "Starting…" : "Run agent";
    elements.runForm.setAttribute("aria-busy", String(busy));
  }

  function setRefreshBusy(busy) {
    elements.refreshButton.disabled = busy;
    elements.refreshButton.classList.toggle("is-spinning", busy);
  }

  function updatePromptCount() {
    elements.promptCount.textContent = `${elements.promptInput.value.length.toLocaleString()} / 4,000`;
  }

  function showNotice(message) {
    elements.noticeText.textContent = message;
    elements.notice.hidden = false;
  }

  function hideNotice() {
    elements.notice.hidden = true;
    elements.noticeText.textContent = "";
  }

  function showToast(message) {
    window.clearTimeout(state.toastTimer);
    elements.toast.textContent = message;
    elements.toast.hidden = false;
    state.toastTimer = window.setTimeout(() => {
      elements.toast.hidden = true;
    }, 3200);
  }

  function showEmptyTrace() {
    elements.emptyTrace.hidden = false;
    elements.traceContent.hidden = true;
    elements.tracePanel.setAttribute("aria-busy", "false");
  }

  function renderProjectSkeletons() {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 3; index += 1) {
      const card = createElement("div", "project-skeleton");
      for (let line = 0; line < 4; line += 1) card.append(createElement("div", "skeleton"));
      fragment.append(card);
    }
    elements.projectGrid.replaceChildren(fragment);
  }

  function renderRunSkeletons() {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 4; index += 1) {
      const item = createElement("div", "run-skeleton");
      for (let line = 0; line < 3; line += 1) item.append(createElement("div", "skeleton"));
      fragment.append(item);
    }
    elements.runList.replaceChildren(fragment);
  }

  function renderProjectsError() {
    elements.projectGrid.setAttribute("aria-busy", "false");
    elements.projectGrid.replaceChildren(createEmptyState("!", "Projects unavailable", "Refresh when the local API is ready."));
    elements.projectsSummary.textContent = "The project registry could not be reached.";
  }

  function renderRunsError() {
    elements.runList.setAttribute("aria-busy", "false");
    elements.runList.replaceChildren(createEmptyState("!", "Runs unavailable", "Refresh when the local API is ready."));
    elements.runCount.textContent = "—";
  }

  function createEmptyState(mark, title, description) {
    const wrapper = createElement("div", "empty-list");
    wrapper.append(
      createElement("span", "empty-list-mark", mark),
      createElement("strong", "", title),
      createElement("p", "", description),
    );
    return wrapper;
  }

  function statusBadge(status, extraClass = "status-badge") {
    const badge = createElement("span", extraClass, humanStatus(status));
    badge.classList.add(`tone-${safeSlug(status)}`);
    return badge;
  }

  function applyStatusBadge(element, status) {
    element.className = "status-badge";
    element.classList.add(`tone-${safeSlug(status)}`);
    element.textContent = humanStatus(status);
  }

  function findInvocation(approval, invocations) {
    return arrayFrom(invocations).find((invocation) =>
      invocation.id === approval.invocationId || invocation.id === approval.invocation_id,
    );
  }

  function projectName(projectId) {
    if (!projectId) return "All projects";
    const project = state.projects.find((item) => String(item.id) === String(projectId));
    return project ? firstText(project.name, project.title, project.id) : `Project ${shortId(projectId)}`;
  }

  function deadlineLabel(value) {
    if (!value) return "No deadline";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Deadline set";
    return `Due ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date)}`;
  }

  function initials(value) {
    return String(value || "?")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join("") || "?";
  }

  function humanStatus(status) {
    const value = normalizedStatus(status);
    const labels = {
      waiting_for_approval: "Needs approval",
      succeeded: "Succeeded",
      failed: "Failed",
      cancelled: "Cancelled",
      queued: "Queued",
      running: "Running",
      pending: "Pending",
      approved: "Approved",
      rejected: "Rejected",
      at_risk: "At risk",
      off_track: "Off track",
      in_progress: "In progress",
    };
    return labels[value] || value.replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase());
  }

  function eventKind(type) {
    const value = type.toLowerCase();
    if (value.includes("error") || value.includes("fail") || value.includes("denied")) return "error";
    if (value.includes("tool") || value.includes("approval") || value.includes("policy")) return "tool";
    if (value.includes("complete") || value.includes("finish") || value.includes("output")) return "output";
    return "event";
  }

  function eventSymbol(type) {
    const kind = eventKind(type);
    if (kind === "tool") return "→";
    if (kind === "output") return "✓";
    if (kind === "error") return "!";
    if (type.toLowerCase().includes("model")) return "AI";
    if (type.toLowerCase().includes("memory")) return "M";
    return "·";
  }

  function eventTitle(type) {
    const known = {
      "run.created": "Run created",
      "run.started": "Agent started",
      "run.completed": "Run completed",
      "run.failed": "Run failed",
      "model.requested": "Model turn requested",
      "model.completed": "Model turn completed",
      "tool.requested": "Tool call requested",
      "tool.started": "Tool execution started",
      "tool.completed": "Tool execution completed",
      "tool.failed": "Tool execution failed",
      "approval.requested": "Approval requested",
      "approval.resolved": "Approval resolved",
      "memory.retrieved": "Memory retrieved",
      "feedback.recorded": "Preference signal recorded",
    };
    if (known[type]) return known[type];
    return type
      .replace(/[._-]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function summarizeEvent(type, data) {
    if (data === null || data === undefined) return `${type} recorded.`;
    if (typeof data === "string") return data;
    if (typeof data !== "object") return String(data);
    const value = data;
    const direct = firstText(value.message, value.text, value.summary, value.reason, value.error);
    if (direct) return direct;
    const name = firstText(value.toolName, value.tool_name, value.name);
    if (name && type.toLowerCase().includes("tool")) {
      const status = firstText(value.status);
      return status ? `${name} · ${humanStatus(status)}` : `${name} entered the execution trace.`;
    }
    if (value.usage && isObject(value.usage)) {
      const total = numberFrom(value.usage.totalTokens || value.usage.total_tokens);
      if (total) return `Model turn used ${total.toLocaleString()} tokens.`;
    }
    const status = firstText(value.status);
    if (status) return `Status changed to ${humanStatus(status)}.`;
    return "Structured event recorded. Open the payload for exact details.";
  }

  function formatArguments(value) {
    if (typeof value === "string") {
      try {
        return JSON.stringify(JSON.parse(value), null, 2);
      } catch (_error) {
        return value;
      }
    }
    return formatJson(value);
  }

  function formatJson(value) {
    try {
      const formatted = JSON.stringify(value, null, 2);
      return formatted === undefined ? String(value) : formatted;
    } catch (_error) {
      return String(value);
    }
  }

  function normalizeDetail(payload) {
    const base = isObject(payload) && isObject(payload.data) ? payload.data : payload;
    if (!isObject(base)) return { run: null, events: [], approvals: [], feedback: [], invocations: [] };
    const run = isObject(base.run) ? base.run : base;
    return {
      run,
      events: unwrapArray(base.events, "events"),
      approvals: unwrapArray(base.approvals, "approvals"),
      feedback: unwrapArray(base.feedback, "feedback"),
      invocations: unwrapArray(base.invocations || base.toolInvocations, "invocations"),
    };
  }

  function unwrapArray(payload, key) {
    if (Array.isArray(payload)) return payload;
    if (!isObject(payload)) return [];
    if (Array.isArray(payload[key])) return payload[key];
    if (Array.isArray(payload.items)) return payload.items;
    if (Array.isArray(payload.data)) return payload.data;
    if (isObject(payload.data)) {
      if (Array.isArray(payload.data[key])) return payload.data[key];
      if (Array.isArray(payload.data.items)) return payload.data.items;
    }
    return [];
  }

  function unwrapObject(payload, key) {
    if (!isObject(payload)) return {};
    if (isObject(payload[key])) return payload[key];
    if (isObject(payload.data)) {
      if (isObject(payload.data[key])) return payload.data[key];
      return payload.data;
    }
    return payload;
  }

  function upsertRun(run) {
    if (!run || !run.id) return;
    const index = state.runs.findIndex((item) => item.id === run.id);
    if (index >= 0) state.runs[index] = { ...state.runs[index], ...run };
    else state.runs.unshift(run);
    state.runs = sortRuns(state.runs);
  }

  function sortRuns(runs) {
    return arrayFrom(runs).slice().sort((left, right) => dateValue(right.createdAt || right.updatedAt) - dateValue(left.createdAt || left.updatedAt));
  }

  function relativeTime(value) {
    const timestamp = dateValue(value);
    if (!timestamp) return "Unknown time";
    const deltaSeconds = Math.round((timestamp - Date.now()) / 1000);
    const absolute = Math.abs(deltaSeconds);
    const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    if (absolute < 60) return formatter.format(deltaSeconds, "second");
    if (absolute < 3600) return formatter.format(Math.round(deltaSeconds / 60), "minute");
    if (absolute < 86400) return formatter.format(Math.round(deltaSeconds / 3600), "hour");
    if (absolute < 604800) return formatter.format(Math.round(deltaSeconds / 86400), "day");
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(timestamp));
  }

  function formatClock(value) {
    const timestamp = dateValue(value);
    if (!timestamp) return "—";
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(timestamp));
  }

  async function request(path, options = {}) {
    const headers = { Accept: "application/json", ...(options.headers || {}) };
    if (options.body) headers["Content-Type"] = "application/json";
    const response = await fetch(path, { ...options, headers });
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (_error) {
        payload = text;
      }
    }
    if (!response.ok) {
      const message = isObject(payload)
        ? firstText(payload.message, isObject(payload.error) ? payload.error.message : payload.error, response.statusText)
        : firstText(payload, response.statusText);
      throw new Error(message || `Request failed with status ${response.status}.`);
    }
    return payload;
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function createElement(tag, className = "", text = undefined) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  function createOption(value, label) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    return option;
  }

  function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function arrayFrom(value) {
    return Array.isArray(value) ? value : [];
  }

  function firstText(...values) {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
    return "";
  }

  function numberFrom(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function dateValue(value) {
    if (!value) return 0;
    const timestamp = new Date(value).getTime();
    return Number.isNaN(timestamp) ? 0 : timestamp;
  }

  function shortId(value) {
    const text = String(value || "—");
    return text.length > 11 ? `${text.slice(0, 8)}…` : text;
  }

  function safeSlug(value) {
    return String(value || "unknown").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  }

  function normalizedStatus(value) {
    return String(value || "unknown").trim().toLowerCase().replace(/[\s-]+/g, "_");
  }

  function pluralize(count, noun) {
    return count === 1 ? noun : `${noun}s`;
  }

  function errorText(error) {
    return error instanceof Error ? error.message : String(error || "Unknown error");
  }
})();
