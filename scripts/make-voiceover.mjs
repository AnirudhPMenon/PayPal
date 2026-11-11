// Generates the demo video's narration with Gemini text-to-speech, one WAV file per scene.
// Run: node --env-file=.env scripts/make-voiceover.mjs
// Output: recordings/vo/00.wav … 14.wav
// Optional env: VO_MODEL (a Gemini TTS model name), VO_VOICE (default "Charon").
import fs from "node:fs";
import path from "node:path";

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) {
  console.error("GEMINI_API_KEY is missing from .env");
  process.exit(1);
}
const VOICE = process.env.VO_VOICE || "Charon";
const OUT = path.join(process.cwd(), "recordings", "vo");
fs.mkdirSync(OUT, { recursive: true });

// One line per scene of the edited video, in order.
const LINES = [
  "This is Duely, an AI agent that gets freelancers paid.",
  "I type who to bill in plain English. Gemini pulls out the items, the due date, and Priya's share.",
  "Anything that sends money out needs my approval. One click, and it's a real PayPal order with a pay link.",
  "Ravi pays through PayPal checkout. This is PayPal's sandbox, so it's test money.",
  "Duely captures the payment instantly. And without me touching anything, Priya's thirty percent goes out through PayPal Payouts.",
  "Hourly work and relative due dates? Handled.",
  "When a client goes quiet, Duely writes the reminder for me, ready to send on WhatsApp. Ask again, and the tone gets firmer.",
  "For ongoing clients, Duely sets up a monthly retainer using PayPal's official Agent Toolkit.",
  "The client approves once in PayPal,",
  "and from then on, PayPal bills them every month, automatically.",
  "Questions like, any open disputes, are answered with PayPal's own toolkit tools.",
  "Duely also works as an MCP server, so other AI agents can use it. Here, a scheduling agent settles a finished job. It bills the client, and asks to pay the subcontractor.",
  "Outside agents can ask, but only I can approve the payout.",
  "Bill, collect, split, chase, and run retainers. All on PayPal, from one conversation.",
  "That's Duely.",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = "https://generativelanguage.googleapis.com/v1beta";

async function pickModel() {
  if (process.env.VO_MODEL) return process.env.VO_MODEL;
  const res = await fetch(`${BASE}/models?pageSize=200`, { headers: { "x-goog-api-key": KEY } });
  const data = await res.json();
  const names = (data.models || []).map((m) => m.name.replace(/^models\//, "")).filter((n) => /tts/i.test(n));
  if (!names.length) throw new Error("No Gemini text-to-speech model is available for this key.");
  console.log("TTS models available:", names.join(", "));
  return names.find((n) => /flash/i.test(n)) || names[0];
}

function wav(pcm, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function speak(model, text) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`${BASE}/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Read this as a calm, confident narrator in a product demo, at a natural pace: ${text}` }] }],
        generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } } },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      if (!part) throw new Error("No audio in response: " + JSON.stringify(data).slice(0, 200));
      const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType || "")?.[1] || 24000);
      return wav(Buffer.from(part.inlineData.data, "base64"), rate);
    }
    const msg = data?.error?.message || res.statusText;
    if ([429, 500, 503].includes(res.status)) {
      const wait = Number(/retry in ([\d.]+)s/i.exec(msg)?.[1] || 0) * 1000 || 15000 * (attempt + 1);
      console.log(`  busy (${res.status}), waiting ${Math.round(wait / 1000)}s…`);
      await sleep(wait);
      continue;
    }
    throw new Error(`${res.status}: ${msg}`);
  }
  throw new Error("Gave up after several retries");
}

const model = await pickModel();
console.log(`Using ${model}, voice ${VOICE}\n`);
for (let i = 0; i < LINES.length; i++) {
  const file = path.join(OUT, String(i).padStart(2, "0") + ".wav");
  if (fs.existsSync(file) && !process.env.VO_FORCE) {
    console.log(`✓ ${path.basename(file)} (already done)`);
    continue;
  }
  const audio = await speak(model, LINES[i]);
  fs.writeFileSync(file, audio);
  console.log(`✓ ${path.basename(file)}  ${((audio.length - 44) / 48000).toFixed(1)}s  ${LINES[i].slice(0, 60)}`);
}
console.log(`\nDone. ${LINES.length} clips in recordings/vo`);
