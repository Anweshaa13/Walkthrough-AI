const $ = id => document.getElementById(id);


// ============================================
// ELEMENTS
// ============================================

const statusPill = $("statusPill");

const taskInput = $("taskInput");

const teachBtn = $("teachBtn");
const saveBtn = $("saveBtn");
const runBtn = $("runBtn");
const resetBtn = $("resetBtn");

const workflowBox = $("workflowBox");
const workflowSteps = $("workflowSteps");

const browserImage = $("browserImage");
const emptyBrowser = $("emptyBrowser");
const browserUrl = $("browserUrl");
const browserStep = $("browserStep");

const contextTask = $("contextTask");
const contextStatus = $("contextStatus");
const contextAction = $("contextAction");
const copilotState = $("copilotState");

const chat = $("chat");
const questionInput = $("questionInput");
const sendBtn = $("sendBtn");

const activity = $("activity");
const stepCount = $("stepCount");

let currentWorkflow = null;
let lastHistoryLength = 0;


// ============================================
// API
// ============================================

async function api(path, options = {}) {

  const response =
    await fetch(path, {
      headers: {
        "Content-Type": "application/json"
      },
      ...options
    });

  const data =
    await response.json()
      .catch(() => ({}));

  if (!response.ok) {

    throw new Error(
      data.error ||
      "Request failed"
    );
  }

  return data;
}


// ============================================
// CHAT
// ============================================

function addChat(role, text) {

  const row =
    document.createElement("div");

  row.className =
    `chat-message ${role}`;

  row.innerHTML = `
    <div class="avatar">
      ${role === "user" ? "A" : "✦"}
    </div>

    <div>
      <small>
        ${role === "user" ? "You" : "Copilot"}
      </small>

      <p>
        ${escapeHtml(text)}
      </p>
    </div>
  `;

  chat.appendChild(row);

  chat.scrollTop =
    chat.scrollHeight;
}


// ============================================
// ACTIVITY
// ============================================

function addActivity(item) {

  const row =
    document.createElement("div");

  row.className =
    "activity-row";

  let text =
    item.reason ||
    item.action ||
    item.text ||
    "Action";

  row.innerHTML = `
    <b>
      #${item.step || ""}
    </b>

    <span>
      ${escapeHtml(text)}
    </span>
  `;

  activity.appendChild(row);

  while (
    activity.children.length > 30
  ) {

    activity.removeChild(
      activity.firstChild
    );
  }

  activity.scrollTop =
    activity.scrollHeight;
}


// ============================================
// RENDER
// ============================================

function render(state) {

  const status =
    state.status || "idle";

  statusPill.className =
    `status-pill ${status}`;

  const labels = {

    idle: "READY",

    teaching: "TEACHING",

    taught: "WORKFLOW READY",

    starting: "STARTING",

    running: "RUNNING",

    paused: "PAUSED",

    completed: "COMPLETED",

    needs_input: "NEEDS INPUT",

    error: "ERROR"
  };

  const label =
    labels[status] ||
    status.toUpperCase();

  statusPill.innerHTML =
    `<span></span> ${label}`;


  // ------------------------------------------
  // BUTTONS
  // ------------------------------------------

  if (teachBtn) {

    teachBtn.disabled =
      state.running;

  }

  if (saveBtn) {

    saveBtn.disabled =
      !currentWorkflow ||
      state.running;

  }

  if (runBtn) {

    runBtn.disabled =
      state.running ||
      !state.taughtSteps ||
      state.taughtSteps.length === 0;

    runBtn.textContent =
      state.running
        ? "● Workflow Running"
        : "▶ Run Saved Workflow";
  }

  taskInput.disabled =
    state.running;


  // ------------------------------------------
  // CONTEXT
  // ------------------------------------------

  contextTask.textContent =
    state.task ||
    "—";

  contextStatus.textContent =
    label;

  contextAction.textContent =
    state.currentAction ||
    "Waiting";

  copilotState.textContent =
    state.paused
      ? "Workflow paused — answering you"
      : state.running
        ? "Workflow running — ask anything"
        : "Ready to help";


  // ------------------------------------------
  // BROWSER
  // ------------------------------------------

  browserUrl.textContent =
    state.url ||
    "about:blank";

  browserStep.textContent =
    state.currentAction ||
    "Waiting";


  if (state.screenshot) {

    browserImage.src =
      `data:image/jpeg;base64,${state.screenshot}`;

    browserImage.classList.add(
      "show"
    );

    emptyBrowser.style.display =
      "none";
  }


  if (state.lastError) {

    browserStep.textContent =
      state.lastError;
  }


  // ------------------------------------------
  // WORKFLOW
  // ------------------------------------------

  if (
    state.taughtSteps &&
    state.taughtSteps.length
  ) {

    currentWorkflow = {
      name:
        state.task ||
        "Saved Workflow",

      steps:
        state.taughtSteps
    };

    renderWorkflow(
      currentWorkflow
    );
  }


  // ------------------------------------------
  // ACTIVITY
  // ------------------------------------------

  const history =
    state.history || [];

  if (
    history.length >
    lastHistoryLength
  ) {

    history
      .slice(lastHistoryLength)
      .forEach(addActivity);

    lastHistoryLength =
      history.length;
  }

  stepCount.textContent =
    `${state.currentStepIndex >= 0
      ? state.currentStepIndex + 1
      : 0
    } / ${
      state.taughtSteps?.length || 0
    }`;
}


// ============================================
// WORKFLOW DISPLAY
// ============================================

function renderWorkflow(workflow) {

  if (!workflowSteps)
    return;

  workflowSteps.innerHTML = "";

  workflow.steps.forEach(
    (step, index) => {

      const row =
        document.createElement("div");

      row.className =
        "workflow-step";

      row.innerHTML = `
        <div class="workflow-number">
          ${index + 1}
        </div>

        <div>
          <small>
            STEP ${index + 1}
          </small>

          <p>
            ${escapeHtml(step)}
          </p>
        </div>
      `;

      workflowSteps.appendChild(
        row
      );
    }
  );

  workflowBox.style.display =
    "block";
}


// ============================================
// POLL
// ============================================

async function poll() {

  try {

    const data =
      await api(
        "/api/state"
      );

    render(
      data.agent
    );

  } catch (error) {

    console.error(
      error
    );
  }
}


// ============================================
// TEACH
// ============================================

teachBtn.addEventListener(
  "click",
  async () => {

    const goal =
      taskInput.value.trim();

    if (!goal) {

      taskInput.focus();

      return;
    }

    teachBtn.disabled =
      true;

    teachBtn.textContent =
      "🧠 Teaching...";

    addChat(
      "agent",
      `I'm learning this workflow: "${goal}"`
    );

    try {

      const data =
        await api(
          "/api/teach",
          {
            method: "POST",

            body:
              JSON.stringify({
                goal
              })
          }
        );

      currentWorkflow =
        data.workflow;

      renderWorkflow(
        currentWorkflow
      );

      addChat(
        "agent",
        `I've broken that goal into ${data.workflow.steps.length} fixed steps. Review them and save the workflow when you're ready.`
      );

      render(
        data.agent
      );

    } catch (error) {

      addChat(
        "agent",
        `I couldn't learn that workflow: ${error.message}`
      );

    } finally {

      teachBtn.disabled =
        false;

      teachBtn.textContent =
        "🧠 Teach with AI";
    }
  }
);


// ============================================
// SAVE
// ============================================

saveBtn.addEventListener(
  "click",
  async () => {

    if (!currentWorkflow)
      return;

    saveBtn.disabled =
      true;

    try {

      const data =
        await api(
          "/api/save-workflow",
          {
            method: "POST",

            body:
              JSON.stringify({
                workflow:
                  currentWorkflow
              })
          }
        );

      addChat(
        "agent",
        "Workflow saved. These steps are now fixed for the live run."
      );

      render(
        data.agent
      );

    } catch (error) {

      addChat(
        "agent",
        `I couldn't save the workflow: ${error.message}`
      );

      saveBtn.disabled =
        false;
    }
  }
);


// ============================================
// RUN
// ============================================

runBtn.addEventListener(
  "click",
  async () => {

    activity.innerHTML =
      "";

    lastHistoryLength =
      0;

    addChat(
      "agent",
      "Starting the saved workflow in a real browser. I'll execute each fixed step one at a time."
    );

    try {

      await api(
        "/api/run",
        {
          method: "POST"
        }
      );

    } catch (error) {

      addChat(
        "agent",
        error.message
      );
    }

    poll();
  }
);


// ============================================
// RESET
// ============================================

resetBtn.addEventListener(
  "click",
  async () => {

    try {

      await api(
        "/api/reset",
        {
          method: "POST"
        }
      );

      activity.innerHTML =
        "";

      lastHistoryLength =
        0;

      currentWorkflow =
        null;

      if (workflowBox) {

        workflowBox.style.display =
          "none";
      }

      browserImage.classList.remove(
        "show"
      );

      emptyBrowser.style.display =
        "grid";

      addChat(
        "agent",
        "Everything is reset. Teach me a new workflow whenever you're ready."
      );

      poll();

    } catch (error) {

      addChat(
        "agent",
        error.message
      );
    }
  }
);


// ============================================
// COPILOT
// ============================================

async function sendQuestion() {

  const question =
    questionInput.value.trim();

  if (!question)
    return;

  addChat(
    "user",
    question
  );

  questionInput.value =
    "";

  sendBtn.disabled =
    true;

  sendBtn.textContent =
    "⏸ Pausing...";

  try {

    const data =
      await api(
        "/api/copilot",
        {
          method: "POST",

          body:
            JSON.stringify({
              question
            })
        }
      );

    addChat(
      "agent",
      data.answer
    );

    render(
      data.agent
    );

  } catch (error) {

    addChat(
      "agent",
      `I couldn't answer that: ${error.message}`
    );

  } finally {

    sendBtn.disabled =
      false;

    sendBtn.textContent =
      "Ask Copilot ↗";

    questionInput.focus();
  }
}


sendBtn.addEventListener(
  "click",
  sendQuestion
);


questionInput.addEventListener(
  "keydown",
  event => {

    if (
      event.key === "Enter" &&
      !event.shiftKey
    ) {

      event.preventDefault();

      sendQuestion();
    }
  }
);


// ============================================
// ESCAPE HTML
// ============================================

function escapeHtml(value) {

  return String(value)

    .replaceAll(
      "&",
      "&amp;"
    )

    .replaceAll(
      "<",
      "&lt;"
    )

    .replaceAll(
      ">",
      "&gt;"
    )

    .replaceAll(
      '"',
      "&quot;"
    )

    .replaceAll(
      "'",
      "&#039;"
    );
}


// ============================================
// START
// ============================================

setInterval(
  poll,
  1000
);

poll();