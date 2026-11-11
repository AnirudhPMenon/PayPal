// Agent-to-agent commerce demo in the terminal.
// A separate AI agent ("JobBoard") marks a job complete and settles the money by talking to Duely over MCP.
// The same agent also runs from the Agents page in the dashboard (/agents).
//
// Run (with `npm start` running in another terminal):
//   npm run agent-demo
//   npm run agent-demo -- "Job #88 for Meera's bakery is done: website fixes, 4 hours at $35/hr. Pay Sam (sam@example.com) $60 for his part."
import { runJobBoard, defaultJobTask } from "../lib/jobboard.js";

const c = { dim: "\x1b[2m", bold: "\x1b[1m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", off: "\x1b[0m" };
const task = process.argv.slice(2).join(" ") || defaultJobTask(process.env.RECIPIENT_EMAIL);
const duelyUrl = (process.env.DUELY_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, "");

try {
  await runJobBoard({
    task,
    duelyUrl,
    onEvent: (e) => {
      if (e.type === "connected") console.log(`\n${c.bold}JobBoard agent${c.off} connected to ${c.cyan}Duely${c.off} over MCP (${e.tools} tools)\n\n${c.dim}Task:${c.off} ${e.task}\n`);
      if (e.type === "call") console.log(`${c.yellow}→ MCP tools/call ${e.tool}${c.off} ${c.dim}${JSON.stringify(e.args)}${c.off}`);
      if (e.type === "result") console.log(`${c.green}← ${e.error ? "error: " + e.error : e.status}${c.off}\n`);
      if (e.type === "done") console.log(`${c.bold}JobBoard agent:${c.off} ${e.text}\n\n${c.dim}Open the Duely dashboard: the bill is live and the payout is waiting for your approval.${c.off}\n`);
    },
  });
} catch (e) {
  console.error("Demo failed:", e.message);
  process.exitCode = 1;
}
