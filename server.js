require("dotenv").config();

const express = require("express");
const path = require("path");
const cors = require("cors");

const {
  teachWorkflow,
  saveWorkflow,
  runAgent,
  askCopilot,
  resetAgent,
  getState
} = require("./agent");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));


// ============================================
// STATUS
// ============================================

app.get("/api/status", (req, res) => {
  res.json({
    success: true,
    agent: getState()
  });
});


// ============================================
// TEACH
// ============================================

app.post("/api/teach", async (req, res) => {

  const goal = String(
    req.body.goal || ""
  ).trim();

  if (!goal) {
    return res.status(400).json({
      success: false,
      error: "Please describe what you want the agent to learn."
    });
  }

  try {

    const result = await teachWorkflow(goal);

    res.json({
      success: true,
      message: "Workflow generated successfully.",
      workflow: result,
      agent: getState()
    });

  } catch (error) {

    console.error("TEACH ERROR:", error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


// ============================================
// SAVE WORKFLOW
// ============================================

app.post("/api/save-workflow", (req, res) => {

  try {

    const workflow = req.body.workflow;

    if (
      !workflow ||
      !Array.isArray(workflow.steps) ||
      workflow.steps.length < 3 ||
      workflow.steps.length > 6
    ) {

      return res.status(400).json({
        success: false,
        error: "Workflow must contain 3–6 steps."
      });
    }

    const saved = saveWorkflow(workflow);

    res.json({
      success: true,
      message: "Workflow saved.",
      workflow: saved,
      agent: getState()
    });

  } catch (error) {

    console.error("SAVE ERROR:", error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


// ============================================
// RUN SAVED WORKFLOW
// ============================================

app.post("/api/run", async (req, res) => {

  const state = getState();

  if (state.running) {

    return res.status(409).json({
      success: false,
      error: "A workflow is already running."
    });
  }

  if (!state.taughtSteps || state.taughtSteps.length === 0) {

    return res.status(400).json({
      success: false,
      error: "Teach and save a workflow first."
    });
  }

  // Start asynchronously.
  runAgent().catch(error => {
    console.error("AGENT ERROR:", error);
  });

  res.json({
    success: true,
    message: "Saved workflow started.",
    agent: getState()
  });
});


// ============================================
// LIVE STATE
// ============================================

app.get("/api/state", (req, res) => {

  res.json({
    success: true,
    agent: getState()
  });
});


// ============================================
// COPILOT
// ============================================

app.post("/api/copilot", async (req, res) => {

  const question = String(
    req.body.question || ""
  ).trim();

  if (!question) {

    return res.status(400).json({
      success: false,
      error: "Question is required."
    });
  }

  try {

    const answer =
      await askCopilot(question);

    res.json({
      success: true,
      answer,
      agent: getState()
    });

  } catch (error) {

    console.error("COPILOT ERROR:", error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


// ============================================
// RESET
// ============================================

app.post("/api/reset", async (req, res) => {

  try {

    await resetAgent();

    res.json({
      success: true,
      message: "Agent reset.",
      agent: getState()
    });

  } catch (error) {

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


// ============================================
// SERVER
// ============================================

app.listen(PORT, () => {

  console.log("");
  console.log("==========================================");
  console.log("🚀 WALKTHROUGH AI");
  console.log("==========================================");
  console.log(`🌐 http://localhost:${PORT}`);
  console.log(
    `🧠 Gemini: ${
      process.env.GEMINI_MODEL ||
      "gemini-3.6-flash"
    }`
  );
  console.log(
    `👁 Browser: ${
      process.env.HEADLESS ||
      "false"
    }`
  );
  console.log("==========================================");
  console.log("");

});