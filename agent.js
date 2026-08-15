require("dotenv").config();

const { chromium } = require("playwright");
const { GoogleGenAI } = require("@google/genai");

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

// --------------------------------------------------
// GEMINI MODEL
// --------------------------------------------------

const configuredModel = process.env.GEMINI_MODEL || "";

const MODEL = configuredModel || "gemini-3.5-flash-lite";

// --------------------------------------------------
// BROWSER
// --------------------------------------------------

let browser = null;
let page = null;

// --------------------------------------------------
// AGENT STATE
// --------------------------------------------------

let running = false;
let paused = false;
let pauseRequested = false;

let task = "";
let status = "idle";
let currentAction = "Waiting";
let lastError = "";

let history = [];
let step = 0;
let screenshot = null;
let lastElements = [];

// --------------------------------------------------
// FIXED WORKFLOW
// --------------------------------------------------

let taughtSteps = [];
let workflowSaved = false;
let currentStepIndex = 0;

// --------------------------------------------------
// TRUE PAUSE / RESUME HANDSHAKE
// --------------------------------------------------

let pauseAcknowledgedResolve = null;
let pauseAcknowledgedPromise = null;

let resumeResolve = null;
let resumePromise = null;

function createPauseHandshake() {
  pauseAcknowledgedPromise = new Promise(resolve => {
    pauseAcknowledgedResolve = resolve;
  });

  resumePromise = new Promise(resolve => {
    resumeResolve = resolve;
  });
}

function requestPause(reason) {
  if (!running) {
    return false;
  }

  if (!pauseRequested) {
    pauseRequested = true;
    paused = true;
    status = "paused";

    currentAction =
      reason || "Pausing for Copilot...";

    createPauseHandshake();
  }

  return true;
}

function acknowledgePause() {
  if (!pauseRequested) {
    return;
  }

  paused = true;
  status = "paused";

  if (pauseAcknowledgedResolve) {
    const resolve =
      pauseAcknowledgedResolve;

    pauseAcknowledgedResolve = null;

    resolve();
  }
}

function resumeFromPause() {
  if (!pauseRequested) {
    return;
  }

  pauseRequested = false;
  paused = false;
  status = "running";

  if (resumeResolve) {
    const resolve = resumeResolve;

    resumeResolve = null;
    resumePromise = null;

    resolve();
  }
}

async function waitAtCheckpoint() {
  if (!pauseRequested || !running) {
    return;
  }

  // Tell Copilot that the main agent has
  // actually reached a safe stopping point.
  acknowledgePause();

  // BLOCK HERE until Copilot finishes.
  if (resumePromise) {
    await resumePromise;
  }
}

// --------------------------------------------------
// STATE
// --------------------------------------------------

function getState() {
  return {
    running,
    paused,
    status,

    task,
    currentAction,
    lastError,

    step,

    taughtSteps,
    workflowSaved,
    currentStepIndex,

    url:
      page && !page.isClosed()
        ? page.url()
        : "",

    title: "",

    history:
      history.slice(-30),

    screenshot
  };
}

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

function pushHistory(
  action,
  reason = "",
  target = "",
  value = ""
) {
  history.push({
    step: currentStepIndex + 1,
    action,
    target,
    value,
    reason
  });

  if (history.length > 100) {
    history = history.slice(-100);
  }
}

async function safeObserve() {
  try {
    return await observe();
  } catch {
    return {
      url:
        page && !page.isClosed()
          ? page.url()
          : "",
      title: "",
      text: "",
      elements: []
    };
  }
}

// --------------------------------------------------
// OBSERVE BROWSER
// --------------------------------------------------

async function observe() {
  if (!page || page.isClosed()) {
    return {
      url: "",
      title: "",
      text: "",
      elements: []
    };
  }

  const text =
    await page
      .locator("body")
      .innerText({
        timeout: 8000
      })
      .catch(() => "");

  const elements =
    await page
      .locator(
        "a,button,input,textarea,select,[role='button']"
      )
      .evaluateAll(nodes =>
        nodes
          .slice(0, 150)
          .map((el, i) => ({
            ref: `e${i}`,

            tag:
              el.tagName.toLowerCase(),

            text: (
              el.innerText ||
              el.getAttribute(
                "aria-label"
              ) ||
              el.getAttribute(
                "placeholder"
              ) ||
              el.value ||
              ""
            )
              .trim()
              .slice(0, 180),

            href:
              el.href || "",

            placeholder:
              el.getAttribute(
                "placeholder"
              ) || ""
          }))
          .filter(
            x =>
              x.text ||
              x.href
          )
      )
      .catch(() => []);

  lastElements = elements;

  screenshot =
    await page
      .screenshot({
        type: "jpeg",
        quality: 55
      })
      .then(b =>
        b.toString("base64")
      )
      .catch(() => null);

  return {
    url: page.url(),

    title:
      await page
        .title()
        .catch(() => ""),

    text:
      text.slice(0, 14000),

    elements
  };
}
// --------------------------------------------------
// TEACH WORKFLOW
// --------------------------------------------------

const teachSchema = {
  type: "OBJECT",

  properties: {
    steps: {
      type: "ARRAY",

      items: {
        type: "STRING"
      }
    }
  },

  required: ["steps"]
};

async function teachWorkflow(goal) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY is missing."
    );
  }

  if (!goal || !String(goal).trim()) {
    throw new Error(
      "Task goal is required."
    );
  }

  const prompt = `
You are the workflow-teaching component
of Walkthrough AI.

Convert the user's natural-language goal
into exactly 3 to 6 clear, ordered steps.

The workflow is FIXED.

The steps must describe WHAT needs
to be accomplished.

Do NOT describe:
- CSS selectors
- DOM details
- coordinates
- implementation details

Example:

User:
Find and play the latest song on the
T-Series YouTube channel.

Workflow:

1. Go to the T-Series YouTube channel
   videos page.

2. Find the most recently posted video.

3. Open the selected video and play it.

USER GOAL:
${goal}

Return ONLY JSON.
`;

  const response =
    await ai.models.generateContent({
      model: MODEL,

      contents: prompt,

      config: {
        responseMimeType:
          "application/json",

        responseSchema:
          teachSchema
      }
    });

  const parsed =
    JSON.parse(
      response.text
    );

  if (
    !Array.isArray(
      parsed.steps
    )
  ) {
    throw new Error(
      "AI did not generate valid workflow steps."
    );
  }

  const steps =
    parsed.steps
      .map(s =>
        String(s).trim()
      )
      .filter(Boolean)
      .slice(0, 6);

  if (
    steps.length < 3 ||
    steps.length > 6
  ) {
    throw new Error(
      "AI must generate between 3 and 6 workflow steps."
    );
  }

  taughtSteps = steps;

  task =
    String(goal).trim();

  workflowSaved = false;

  currentStepIndex = 0;

  status = "taught";

  currentAction =
    "Workflow learned — review and save it.";

  history = [];

  pushHistory(
    "taught",
    `AI learned a ${steps.length}-step workflow.`
  );

  return {
    name: task,
    steps: taughtSteps
  };
}

// --------------------------------------------------
// SAVE WORKFLOW
// --------------------------------------------------

function saveWorkflow(workflow) {
  if (
    !workflow ||
    !Array.isArray(
      workflow.steps
    )
  ) {
    throw new Error(
      "Invalid workflow."
    );
  }

  const steps =
    workflow.steps
      .map(s =>
        String(s).trim()
      )
      .filter(Boolean);

  if (
    steps.length < 3 ||
    steps.length > 6
  ) {
    throw new Error(
      "Workflow must contain 3–6 steps."
    );
  }

  taughtSteps = steps;

  if (workflow.name) {
    task =
      String(
        workflow.name
      );
  }

  workflowSaved = true;

  currentStepIndex = 0;

  status = "taught";

  currentAction =
    "Workflow saved — ready to run.";

  pushHistory(
    "saved",
    "Workflow saved and fixed for this run."
  );

  return {
    name: task,
    steps: taughtSteps
  };
}

// --------------------------------------------------
// ACTION SCHEMA
// --------------------------------------------------

const actionSchema = {
  type: "OBJECT",

  properties: {
    action: {
      type: "STRING",

      enum: [
        "goto",
        "click",
        "type",
        "press",
        "scroll",
        "wait",
        "step_done",
        "ask_user"
      ]
    },

    target: {
      type: "STRING"
    },

    value: {
      type: "STRING"
    },

    reason: {
      type: "STRING"
    }
  },

  required: [
    "action",
    "reason"
  ]
};

// --------------------------------------------------
// PLAN NEXT ACTION
// --------------------------------------------------

async function plan(
  currentStep,
  observation
) {
  const prompt = `
You are the execution engine
of Walkthrough AI.

The workflow is FIXED.

You are NOT allowed to:
- change steps
- reorder steps
- skip steps
- invent steps

Your ONLY job is to determine HOW
to perform the CURRENT STEP.

Choose exactly ONE small action.

FIXED WORKFLOW:

${taughtSteps
  .map(
    (s, i) =>
      `${i + 1}. ${s}`
  )
  .join("\n")}

CURRENT STEP:

Step ${currentStepIndex + 1}
of ${taughtSteps.length}

${currentStep}

CURRENT BROWSER URL:

${observation.url}

CURRENT PAGE TITLE:

${observation.title}

VISIBLE PAGE TEXT:

${observation.text}

INTERACTIVE ELEMENTS:

${JSON.stringify(
  observation.elements
)}

RECENT HISTORY:

${JSON.stringify(
  history.slice(-10)
)}

RULES:

- goto requires a complete https URL.
- click should preferably use an observed ref
  such as e12.
- type uses target as a description.
- type uses value as the text.
- press uses value such as Enter.
- scroll uses up or down.
- wait uses milliseconds.
- step_done ONLY when the current step
  is actually complete.
- ask_user ONLY when a real user decision
  or credential is required.
- Never invent page content.
- Never perform an irreversible action
  without confirmation.

Return ONLY JSON.
`;

  const response =
    await ai.models.generateContent({
      model: MODEL,

      contents: prompt,

      config: {
        responseMimeType:
          "application/json",

        responseSchema:
          actionSchema
      }
    });

  return JSON.parse(
    response.text
  );
}

// --------------------------------------------------
// FIND INPUT
// --------------------------------------------------

async function findInput(
  target = "search"
) {
  const candidates = [
    "input[type='search']",

    "input[placeholder*='Search' i]",

    "input[aria-label*='Search' i]",

    "input[name*='search' i]",

    "textarea",

    "input"
  ];

  for (
    const selector of candidates
  ) {
    const loc =
      page
        .locator(selector)
        .first();

    if (
      (await loc.count()) &&
      (
        await loc
          .isVisible()
          .catch(() => false)
      )
    ) {
      return loc;
    }
  }

  const byPlaceholder =
    page
      .getByPlaceholder(
        String(target),
        {
          exact: false
        }
      )
      .first();

  if (
    (await byPlaceholder.count()) &&
    (
      await byPlaceholder
        .isVisible()
        .catch(() => false)
    )
  ) {
    return byPlaceholder;
  }

  return null;
}
// --------------------------------------------------
// CLICK BY REF
// --------------------------------------------------

async function clickByRef(
  ref
) {
  const index =
    lastElements.findIndex(
      e => e.ref === ref
    );

  if (index === -1) {
    return false;
  }

  const selector =
    "a,button,input,textarea,select,[role='button']";

  const loc =
    page
      .locator(selector)
      .nth(index);

  if (
    (await loc.count()) &&
    (
      await loc
        .isVisible()
        .catch(() => false)
    )
  ) {
    await loc.click({
      timeout: 8000
    });

    return true;
  }

  const element =
    lastElements[index];

  if (
    element &&
    element.text
  ) {
    const byText =
      page
        .locator(selector)
        .filter({
          hasText:
            element.text
        })
        .first();

    if (
      (await byText.count()) &&
      (
        await byText
          .isVisible()
          .catch(() => false)
      )
    ) {
      await byText.click({
        timeout: 8000
      });

      return true;
    }
  }

  return false;
}

// --------------------------------------------------
// CLICK TARGET
// --------------------------------------------------

async function clickTarget(
  target = ""
) {
  // First try agent reference.
  if (
    /^e\d+$/.test(target)
  ) {
    const clicked =
      await clickByRef(
        target
      );

    if (clicked) {
      return;
    }
  }

  // Exact text.
  const exact =
    page
      .getByText(
        target,
        {
          exact: true
        }
      )
      .first();

  if (
    (await exact.count()) &&
    (
      await exact
        .isVisible()
        .catch(() => false)
    )
  ) {
    await exact.click({
      timeout: 8000
    });

    return;
  }

  // Button.
  const button =
    page
      .getByRole(
        "button",
        {
          name: target,
          exact: false
        }
      )
      .first();

  if (
    (await button.count()) &&
    (
      await button
        .isVisible()
        .catch(() => false)
    )
  ) {
    await button.click({
      timeout: 8000
    });

    return;
  }

  // Link.
  const link =
    page
      .locator("a")
      .filter({
        hasText: target
      })
      .first();

  if (
    (await link.count()) &&
    (
      await link
        .isVisible()
        .catch(() => false)
    )
  ) {
    await link.click({
      timeout: 8000
    });

    return;
  }

  // Partial text.
  const partial =
    page
      .getByText(
        target,
        {
          exact: false
        }
      )
      .first();

  if (
    (await partial.count()) &&
    (
      await partial
        .isVisible()
        .catch(() => false)
    )
  ) {
    await partial.click({
      timeout: 8000
    });

    return;
  }

  throw new Error(
    `Could not find clickable target: ${target}`
  );
}

// --------------------------------------------------
// EXECUTE ACTION
// --------------------------------------------------

async function execute(
  action
) {
  currentAction =
    action.reason ||
    action.action;

  if (
    !page ||
    page.isClosed()
  ) {
    throw new Error(
      "Browser page is not available."
    );
  }

  // VERY IMPORTANT:
  // If Copilot requested a pause,
  // stop before performing this action.
  await waitAtCheckpoint();

  if (!running) {
    return;
  }

  // ------------------------------------------
  // GOTO
  // ------------------------------------------

  if (
    action.action === "goto"
  ) {
    if (
      !/^https?:\/\//i.test(
        action.target || ""
      )
    ) {
      throw new Error(
        "Invalid navigation URL."
      );
    }

    console.log(
      "🌐 Navigating to:",
      action.target
    );

    try {
      await page.goto(
        action.target,
        {
          waitUntil:
            "domcontentloaded",

          timeout: 30000
        }
      );

      await page.waitForTimeout(
        1200
      );

    } catch (error) {
      console.log(
        "⚠️ Navigation error:",
        error.message
      );

      if (
        !browser ||
        !browser.isConnected() ||
        page.isClosed()
      ) {
        throw new Error(
          "Browser connection was lost during navigation."
        );
      }

      await sleep(800);

      await page.goto(
        action.target,
        {
          waitUntil:
            "domcontentloaded",

          timeout: 30000
        }
      );

      await page.waitForTimeout(
        1200
      );
    }

    return;
  }

  // ------------------------------------------
  // CLICK
  // ------------------------------------------

  if (
    action.action === "click"
  ) {
    await clickTarget(
      action.target || ""
    );

    await page.waitForTimeout(
      1000
    );

    return;
  }

  // ------------------------------------------
  // TYPE
  // ------------------------------------------

  if (
    action.action === "type"
  ) {
    const input =
      await findInput(
        action.target ||
          "search"
      );

    if (!input) {
      throw new Error(
        `Could not find input: ${
          action.target ||
          "search"
        }`
      );
    }

    await input.fill(
      action.value || ""
    );

    await page.waitForTimeout(
      300
    );

    return;
  }

  // ------------------------------------------
  // PRESS
  // ------------------------------------------

  if (
    action.action === "press"
  ) {
    await page.keyboard.press(
      action.value ||
        "Enter"
    );

    await page.waitForTimeout(
      1200
    );

    return;
  }

  // ------------------------------------------
  // SCROLL
  // ------------------------------------------

  if (
    action.action === "scroll"
  ) {
    const amount =
      action.value === "up"
        ? -700
        : 700;

    await page.mouse.wheel(
      0,
      amount
    );

    await page.waitForTimeout(
      600
    );

    return;
  }

  // ------------------------------------------
  // WAIT
  // ------------------------------------------

  if (
    action.action === "wait"
  ) {
    const ms =
      Math.min(
        Math.max(
          Number(
            action.value
          ) || 1000,
          300
        ),
        4000
      );

    await page.waitForTimeout(
      ms
    );

    return;
  }

  // ------------------------------------------
  // ASK USER
  // ------------------------------------------

  if (
    action.action ===
    "ask_user"
  ) {
    throw new Error(
      "The agent needs a user decision before it can continue."
    );
  }
}
// --------------------------------------------------
// RUN AGENT
// --------------------------------------------------

async function runAgent(
  goal
) {
  if (running) {
    throw new Error(
      "An agent task is already running."
    );
  }

  // Backward compatibility:
  // if server.js directly sends a task,
  // automatically teach + save it.
  if (
    goal &&
    !workflowSaved
  ) {
    await teachWorkflow(
      goal
    );

    saveWorkflow({
      name: goal,
      steps: taughtSteps
    });
  }

  if (!workflowSaved) {
    throw new Error(
      "No saved workflow. Teach and save a workflow first."
    );
  }

  if (
    !process.env.GEMINI_API_KEY
  ) {
    throw new Error(
      "GEMINI_API_KEY is missing."
    );
  }

  running = true;
  paused = false;
  pauseRequested = false;

  status = "starting";

  lastError = "";

  history = [];

  step = 0;

  currentStepIndex = 0;

  currentAction =
    "Starting real browser...";

  try {
    if (browser) {
      await browser
        .close()
        .catch(() => {});
    }

    // ------------------------------------------
    // START PLAYWRIGHT
    // ------------------------------------------

    browser =
      await chromium.launch({
        headless: false,

        args: [
          "--start-maximized",

          "--disable-blink-features=AutomationControlled",

          "--disable-dev-shm-usage",

          "--no-sandbox"
        ]
      });

    page =
      await browser.newPage({
        viewport: {
          width: 1440,
          height: 900
        }
      });

    page.setDefaultTimeout(
      15000
    );

    page.setDefaultNavigationTimeout(
      30000
    );

    // ------------------------------------------
    // INITIAL PAGE
    // ------------------------------------------

    await page.goto(
      "https://www.google.com",
      {
        waitUntil:
          "domcontentloaded",

        timeout: 30000
      }
    );

    await page.waitForTimeout(
      1200
    );

    status = "running";

    // ------------------------------------------
    // FIXED WORKFLOW LOOP
    // ------------------------------------------

    for (
      currentStepIndex = 0;

      currentStepIndex <
        taughtSteps.length &&
        running;

      currentStepIndex++
    ) {
      const currentStep =
        taughtSteps[
          currentStepIndex
        ];

      currentAction =
        `Step ${
          currentStepIndex + 1
        }: ${currentStep}`;

      pushHistory(
        "step_start",
        `Starting Step ${
          currentStepIndex + 1
        }: ${currentStep}`
      );

      await safeObserve();

      let completed = false;

      // Maximum 8 small actions
      // for one fixed step.
      for (
        let i = 0;
        i < 8 && running;
        i++
      ) {
        // ------------------------------------
        // REAL PAUSE CHECKPOINT
        // ------------------------------------

        await waitAtCheckpoint();

        if (!running) {
          break;
        }

        step++;

        // ------------------------------------
        // OBSERVE
        // ------------------------------------

        const observation =
          await safeObserve();

        // ------------------------------------
        // ASK GEMINI
        // ------------------------------------

        const action =
          await plan(
            currentStep,
            observation
          );

        pushHistory(
          action.action,
          action.reason || "",
          action.target || "",
          action.value || ""
        );

        // ------------------------------------
        // CHECK PAUSE AGAIN
        // ------------------------------------
        //
        // Copilot may have requested a pause
        // while Gemini was generating the action.
        //
        // DO NOT execute that action until
        // Copilot has finished.
        // ------------------------------------

        await waitAtCheckpoint();

        if (!running) {
          break;
        }

        // ------------------------------------
        // STEP DONE
        // ------------------------------------

        if (
          action.action ===
          "step_done"
        ) {
          currentAction =
            `Step ${
              currentStepIndex + 1
            } complete: ${
              currentStep
            }`;

          pushHistory(
            "step_complete",
            currentAction
          );

          await safeObserve();

          completed = true;

          break;
        }

        // ------------------------------------
        // USER INPUT
        // ------------------------------------

        if (
          action.action ===
          "ask_user"
        ) {
          status =
            "needs_input";

          currentAction =
            action.reason ||
            "Waiting for user input";

          await safeObserve();

          return getState();
        }

        // ------------------------------------
        // EXECUTE ACTION
        // ------------------------------------

        currentAction =
          action.reason ||
          `Executing ${
            action.action
          }`;

        await execute(
          action
        );

        await safeObserve();

        // Prevent Gemini requests
        // from firing too quickly.
        await sleep(900);
      }

      // ------------------------------------
      // STEP FAILED
      // ------------------------------------

      if (!completed) {
        throw new Error(
          `Could not complete Step ${
            currentStepIndex + 1
          }: ${currentStep}`
        );
      }
    }

    // ------------------------------------------
    // COMPLETE
    // ------------------------------------------

    if (running) {
      status =
        "completed";

      currentAction =
        "All taught workflow steps completed.";

      pushHistory(
        "workflow_complete",
        "Fixed workflow completed successfully."
      );

      await safeObserve();
    }

  } catch (error) {
    lastError =
      error.message ||
      String(error);

    status =
      "error";

    currentAction =
      "Task stopped";

    console.error(
      "❌ AGENT ERROR:",
      error
    );

    await safeObserve();

  } finally {
    running = false;
    paused = false;
    pauseRequested = false;

    pauseAcknowledgedResolve =
      null;

    resumeResolve =
      null;

    pauseAcknowledgedPromise =
      null;

    resumePromise =
      null;
  }

  return getState();
}

// --------------------------------------------------
// COPILOT
// --------------------------------------------------

async function askCopilot(
  question
) {
  if (
    !question ||
    !question.trim()
  ) {
    throw new Error(
      "Question is required."
    );
  }

  const wasRunning =
    running &&
    (
      status === "running" ||
      status === "paused"
    );

  // ------------------------------------------
  // COPILOT WHILE AGENT IS NOT RUNNING
  // ------------------------------------------

  if (!wasRunning) {
    const observation =
      await safeObserve();

    return generateCopilotAnswer(
      question,
      observation
    );
  }

  // ------------------------------------------
  // REQUEST REAL PAUSE
  // ------------------------------------------

  if (!pauseRequested) {
    requestPause(
      `Paused on Step ${
        currentStepIndex + 1
      } to answer your question.`
    );

    pushHistory(
      "copilot_pause",
      `Workflow paused for Copilot: ${question}`
    );
  }

  // ------------------------------------------
  // WAIT UNTIL MAIN AGENT ACTUALLY PAUSES
  // ------------------------------------------

  if (
    pauseAcknowledgedPromise
  ) {
    await pauseAcknowledgedPromise;
  }

  // ------------------------------------------
  // NOW READ LIVE BROWSER
  // ------------------------------------------

  const observation =
    await safeObserve();

  let answer;

  try {
    answer =
      await generateCopilotAnswer(
        question,
        observation
      );

    pushHistory(
      "copilot_answer",
      answer
    );

    return answer;

  } finally {

    // ----------------------------------------
    // RESUME ONLY AFTER ANSWER IS COMPLETE
    // ----------------------------------------

    if (
      wasRunning &&
      pauseRequested &&
      running
    ) {
      currentAction =
        `Resuming Step ${
          currentStepIndex + 1
        }: ${
          taughtSteps[
            currentStepIndex
          ] || ""
        }`;

      pushHistory(
        "copilot_resume",
        `Resuming Step ${
          currentStepIndex + 1
        } after Copilot answer.`
      );

      resumeFromPause();
    }
  }
}

// --------------------------------------------------
// GENERATE COPILOT ANSWER
// --------------------------------------------------

async function generateCopilotAnswer(
  question,
  observation
) {
  const currentStep =
    taughtSteps[
      currentStepIndex
    ] ||
    "No active step";

  const prompt = `
You are Walkthrough AI's friendly
side Copilot.

The main agent controls a real browser
and is executing a FIXED workflow.

The user has asked you a question.

Answer naturally and concisely.

Use ONLY:
- current browser context
- current workflow
- recent agent activity

Do not invent information.

Do not change the workflow.

If the answer cannot be known from
the current context, say so clearly.

USER QUESTION:
${question}

OVERALL TASK:
${task}

FIXED WORKFLOW:

${taughtSteps
  .map(
    (s, i) =>
      `${i + 1}. ${s}`
  )
  .join("\n")}

CURRENT STEP:

Step ${
  currentStepIndex + 1
}
of ${
  taughtSteps.length
}

${currentStep}

CURRENT URL:

${observation.url}

CURRENT PAGE TEXT:

${observation.text}

RECENT AGENT ACTIVITY:

${JSON.stringify(
  history.slice(-12)
)}
`;

  const response =
    await ai.models.generateContent({
      model: MODEL,

      contents: prompt
    });

  return (
    response.text || ""
  ).trim() ||
    "I can see the current task, but I don't have enough information to answer that yet.";
}

// --------------------------------------------------
// RESET
// --------------------------------------------------

async function resetAgent() {
  running = false;
  paused = false;
  pauseRequested = false;

  status = "idle";

  task = "";

  currentAction =
    "Waiting";

  lastError = "";

  history = [];

  step = 0;

  screenshot = null;

  taughtSteps = [];

  workflowSaved = false;

  currentStepIndex = 0;

  lastElements = [];

  // Release a paused agent if necessary.
  if (resumeResolve) {
    resumeResolve();
  }

  pauseAcknowledgedResolve =
    null;

  resumeResolve =
    null;

  pauseAcknowledgedPromise =
    null;

  resumePromise =
    null;

  if (browser) {
    await browser
      .close()
      .catch(() => {});
  }

  browser = null;
  page = null;
}

// --------------------------------------------------
// EXPORTS
// --------------------------------------------------

module.exports = {
  teachWorkflow,
  saveWorkflow,
  runAgent,
  askCopilot,
  resetAgent,
  getState
};