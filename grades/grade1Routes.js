const express = require("express");
const fs = require("fs");
const { parse } = require("csv-parse/sync");
const { Resend } = require("resend");

const router = express.Router();

// ==============================
// 1) Load CSV ONCE (fast)
// ==============================
let PDF_TABLE = [];

function loadPdfTableOnce() {
  const csv = fs.readFileSync("./csv/grade1.csv", "utf8");
  const records = parse(csv, {
    columns: true,
    skip_empty_lines: true,
  });

  PDF_TABLE = records.map((r) => ({
    // keyword kept only because CSV has it, but we won't use it for search
    keyword: (r.keyword || "").trim().toLowerCase(),
    pdf_name: (r.pdf_name || "").trim(),
    pdf_link: (r.pdf_link || "").trim(),
  }));

  console.log(`✅ Loaded ${PDF_TABLE.length} PDFs from grade1.csv`);
}

/**
 * Find PDF by pdf_name (case-insensitive).
 * Supports:
 *  - Exact match first
 *  - Partial "includes" match fallback
 */
// ==============================
// 2) PDF NAME MATCHING (robust)
// ==============================
function normalizeName(str) {
  return (str || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "") // remove special chars like . , - _ /
    .replace(/\s+/g, " ")
    .trim();
}

function scoreMatch(search, candidate) {
  // exact (normalized)
  if (candidate === search) return 1000;

  // substring
  if (candidate.includes(search)) return 700;
  if (search.includes(candidate)) return 650;

  // token overlap scoring
  const sTokens = search.split(" ").filter(Boolean);
  const cTokens = candidate.split(" ").filter(Boolean);
  const cSet = new Set(cTokens);

  let hits = 0;
  for (const t of sTokens) {
    if (cSet.has(t)) hits++;
  }

  const ratio = hits / Math.max(1, sTokens.length);

  // bonus for common important terms (optional)
  let bonus = 0;
  const important = [
  // ===== Grade / Level =====
  "grade 1",
  "g1",
  "k-5",
  "k-5 math",
  "gk",
  "k",
  "gk-3",
  "gk-2",

  // ===== Subjects =====
  "math",
  "rla",
  "fs",

  // ===== Common / Generic =====
  "welcome",
  "letter",
  "family",
  "guide",
  "program",
  "implementation",
  "protocol",
  "internalization",
  "lesson",
  "unit",
  "teacher",
  "coach",
  "student",
  "reading",
  "independent",
  "observation",
  "navigation",
  "component",
  "pacing",
  "scope",
  "sequence",

  // ===== Foundational Skills / Phonics =====
  "foundational",
  "skills",
  "consonant",
  "vowel",
  "code",
  "flip",
  "flip book",
  "book",
  "chart",
  "individual",
  "spelling",
  "cards",
  "letter cards",
  "image",
  "image cards",

  // ===== FS Levels =====
  "fs1",
  "fs2",
  "fs3",
  "fs4",
  "fs5",
  "fs6",
  "fs7",

  // ===== FS Content Types =====
  "activity",
  "activity book",
  "big",
  "big book",
  "reader",
  "digital",
  "digital components",
  "digital visuals",
  "visuals",
  "teacher guide",
  "family support letter",

  // ===== RLA (GK-2) =====
  "rla pacing",
  "rla scope",
  "rla sequence",
  "rla family welcome letter",
  "rla lesson internalization",
  "rla unit internalization",
  "rla independent reading guide",
  "rla component navigation",
  "rla observation tool",
  "rla program implementation guide",

  // ===== Units (RLA Units) =====
  "unit",
  "unit 1",
  "unit 2",
  "unit 3",
  "unit 4",
  "unit 5",
  "unit 6",
  "unit 7",
  "unit 8",
  "unit 9",
  "unit 10",

  // ===== Unit Resources =====
  "digital components visuals",
  "family letter",
  "family support",
  "teacher guide",
  "flip book",
  "image cards",
  "reader information",
  "essential questions",
  "prompts",

  // ===== Math Grade 1 (Course / Resources) =====
  "adsy",
  "additional days",
  "school year",
  "course",
  "course guide",
  "manipulatives",
  "manipulatives kit",
  "math navigation guide",
  "math family guide",
  "math program implementation guide",

  // ===== Modules (Math Grade 1) =====
  "module",
  "module 1",
  "module 2",
  "module 3",
  "module 4",
  "module 5",
  "module 6",

  // ===== Learning Types =====
  "learn",
  "practice",
  "succeed",

  // ===== Math Concepts from titles =====
  "sums",
  "differences",
  "addition",
  "subtraction",
  "within 10",
  "within 20",
  "to 40",
  "to 100",
  "place value",
  "comparison",
  "ordering",
  "comparing",
  "numbers",
  "length",
  "measurement",
  "shapes",
  "composing",
  "partitioning",
  "income",
  "understanding"
];

  for (const w of important) {
    if (search.includes(w) && candidate.includes(w)) bonus += 15;
  }

  return Math.round(ratio * 500) + bonus; // max ~500 + bonus
}

/**
 * Robust find-by-name:
 * - ignores special characters
 * - works for partial phrases
 * - avoids wrong matches using:
 *   1) MIN_SCORE threshold
 *   2) confidence gap threshold between best and 2nd best
 */
function findPdfByName(pdfName) {
  const search = normalizeName(pdfName);
  if (!search) return null;

  // Avoid super-vague inputs matching something random
  if (search.length < 4) return null;

  let best = null;
  let bestScore = -1;
  let secondBestScore = -1;

  for (const row of PDF_TABLE) {
    const candidate = normalizeName(row.pdf_name);
    const s = scoreMatch(search, candidate);

    if (s > bestScore) {
      secondBestScore = bestScore;
      bestScore = s;
      best = row;
    } else if (s > secondBestScore) {
      secondBestScore = s;
    }
  }

  const MIN_SCORE = 140; // reject weak matches
  const MIN_GAP = 40; // reject ambiguous matches

  if (bestScore < MIN_SCORE) return null;

  // If 2nd best is close, it's ambiguous → return null so caller can ask user to clarify
  if (secondBestScore !== -1 && bestScore - secondBestScore < MIN_GAP) {
    console.warn("⚠️ Ambiguous PDF match", {
      input: pdfName,
      normalized: search,
      bestScore,
      secondBestScore,
      bestPdf: best?.pdf_name,
    });
    return null;
  }

  return best;
}

loadPdfTableOnce();

// Reload CSV without restart (optional)
router.get("/reload", (req, res) => {
  try {
    loadPdfTableOnce();
    res.json({ ok: true, count: PDF_TABLE.length });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ==============================
// 2) Resend Client
// ==============================
const resend = new Resend(process.env.RESEND_API_KEY);

// ==============================
// 3) MCP discovery endpoint
// ==============================
router.get("/mcp", (req, res) => {
  res.json({
    name: "teacher-pdf-mcp",
    version: "1.0.0",
    tools: [
      {
        name: "send_pdf_by_name",
        description: "Find PDF by PDF name and email it to the teacher.",
        inputSchema: {
          type: "object",
          properties: {
            pdf_name: { type: "string" },
            teacher_name: { type: "string" },
            teacher_email: { type: "string" },
          },
          required: ["pdf_name", "teacher_name", "teacher_email"],
        },
      },
    ],
  });
});

// ==============================
// 4) MCP tool endpoint (BY NAME)
// ==============================
router.post("/mcp/tools/send_pdf_by_name", async (req, res) => {
  try {
    console.log("----- INCOMING REQUEST -----");
    console.log("HEADERS:", req.headers);
    console.log("BODY:", JSON.stringify(req.body, null, 2));

    const body = req.body || {};

    // 🔑 Smartwebi-first unwrapping
    const data =
      body.customData ||
      body.input ||
      body.arguments ||
      body.payload ||
      body.triggerData ||
      body.contact ||
      body;

    // ✅ Robust field resolution (BY NAME)
    // Accept common variants to avoid mapping issues
    const pdf_name =
      data.keyword ||
      body.customData?.keyword ||
      body.customData?.requested_pdf ||
      body.triggerData?.keyword;

    const teacher_name =
      data.teacher_name ||
      data.teacherName ||
      body.customData?.teacher_name ||
      body.customData?.teacherName ||
      body.full_name ||
      body.first_name ||
      body.contact?.full_name;

    const teacher_email =
      data.teacher_email ||
      data.teacherEmail ||
      body.customData?.teacher_email ||
      body.customData?.teacherEmail ||
      body.email ||
      body.contact?.email;

    console.log("✅ RESOLVED VALUES:", {
      pdf_name,
      teacher_name,
      teacher_email,
    });

    // Validation
    if (!pdf_name || !teacher_name || !teacher_email) {
      return res.status(400).json({
        ok: false,
        message: "Missing required fields",
        resolved: {
          pdf_name,
          teacher_name,
          teacher_email,
        },
        hint: "Ensure fields exist in customData (pdf_name, teacher_name, teacher_email)",
      });
    }

    // Find PDF by NAME
    const found = findPdfByName(pdf_name);
    if (!found) {
      return res.status(404).json({
        ok: false,
        message: "No PDF found for that pdf_name",
        pdf_name,
      });
    }

    // Email content
    // Email content
    const subject = `Requested PDF: ${found.pdf_name}`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Smart School — Document Delivery</title>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Poppins', sans-serif;
      background: linear-gradient(160deg, #E8F6F8 0%, #D4EFF4 40%, #EAF5F7 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 48px 20px;
    }

    .wrapper { max-width: 560px; width: 100%; }

    /* ── Header ── */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
      padding: 0 4px;
    }

    .logo { display: flex; align-items: center; gap: 10px; }

    .logo-icon {
      width: 40px; height: 40px;
      background: linear-gradient(135deg, #2E9FAF, #3BBDCC);
      border-radius: 12px;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 4px 16px rgba(46,159,175,0.35);
      flex-shrink: 0;
    }
    .logo-icon svg { width: 22px; height: 22px; }

    .logo-text { font-size: 15px; font-weight: 700; color: #1A4D55; letter-spacing: -0.01em; }
    .logo-sub  { font-size: 10px; font-weight: 400; color: #7BB5BD; letter-spacing: 0.06em; text-transform: uppercase; }

    .voice-badge {
      display: flex; align-items: center; gap: 7px;
      background: rgba(46,159,175,0.1);
      border: 1px solid rgba(46,159,175,0.25);
      border-radius: 20px; padding: 6px 14px;
      flex-shrink: 0;
    }
    .voice-badge .dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: #2E9FAF;
      animation: pulse 1.8s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); box-shadow: 0 0 0 0 rgba(46,159,175,0.4); }
      50%       { opacity: 0.7; transform: scale(0.85); box-shadow: 0 0 0 4px rgba(46,159,175,0); }
    }
    .voice-badge span { font-size: 10px; font-weight: 600; color: #2E9FAF; letter-spacing: 0.07em; text-transform: uppercase; }

    /* ── Card ── */
    .card {
      background: #FFFFFF;
      border-radius: 24px;
      overflow: hidden;
      border: 1px solid rgba(46,159,175,0.12);
      box-shadow: 0 20px 60px rgba(46,159,175,0.12), 0 4px 16px rgba(0,0,0,0.04);
    }

    /* ── Hero ── */
    .hero {
      background: linear-gradient(145deg, #2E9FAF 0%, #3BBDCC 55%, #52CDD9 100%);
      padding: 40px 44px 38px;
      position: relative;
      overflow: hidden;
    }

    .hero::before {
      content: '';
      position: absolute; top: -50px; right: -50px;
      width: 200px; height: 200px;
      background: rgba(255,255,255,0.12);
      border-radius: 50%;
    }
    .hero::after {
      content: '';
      position: absolute; bottom: -70px; left: -30px;
      width: 180px; height: 180px;
      background: rgba(255,255,255,0.07);
      border-radius: 50%;
    }

    .hero-deco {
      position: absolute; top: 24px; right: 80px;
      width: 90px; height: 90px;
      background: rgba(255,255,255,0.08);
      border-radius: 50%;
    }

    .hero-tag {
      display: inline-flex; align-items: center; gap: 6px;
      background: rgba(255,255,255,0.2);
      border: 1px solid rgba(255,255,255,0.35);
      border-radius: 20px; padding: 4px 12px; margin-bottom: 20px;
    }
    .hero-tag svg { width: 11px; height: 11px; }
    .hero-tag span { font-size: 10px; font-weight: 600; color: #FFFFFF; letter-spacing: 0.08em; text-transform: uppercase; }

    .hero-greeting {
      font-size: 28px; font-weight: 700; color: #FFFFFF;
      line-height: 1.3; margin-bottom: 10px;
      position: relative; z-index: 1;
      text-shadow: 0 2px 12px rgba(0,0,0,0.08);
    }
    .hero-greeting .name-highlight {
      color: #FFFFFF;
      background: rgba(255,255,255,0.25);
      border-radius: 6px;
      padding: 0 8px 2px;
      display: inline-block;
    }

    .hero-sub {
      font-size: 14px; font-weight: 300; color: rgba(255,255,255,0.82);
      line-height: 1.65; position: relative; z-index: 1;
      margin-bottom: 28px;
    }

    /* Waveform */
    .waveform {
      display: flex; align-items: center; gap: 4px;
      position: relative; z-index: 1;
      flex-wrap: nowrap;
    }
    .waveform .bar {
      width: 3px; border-radius: 2px;
      background: rgba(255,255,255,0.7);
      animation: wave 1.5s ease-in-out infinite;
      flex-shrink: 0;
    }
    .waveform .bar:nth-child(1)  { height: 8px;  animation-delay: 0.00s; }
    .waveform .bar:nth-child(2)  { height: 16px; animation-delay: 0.10s; }
    .waveform .bar:nth-child(3)  { height: 24px; animation-delay: 0.20s; }
    .waveform .bar:nth-child(4)  { height: 12px; animation-delay: 0.30s; }
    .waveform .bar:nth-child(5)  { height: 30px; animation-delay: 0.40s; }
    .waveform .bar:nth-child(6)  { height: 18px; animation-delay: 0.50s; }
    .waveform .bar:nth-child(7)  { height: 36px; animation-delay: 0.60s; }
    .waveform .bar:nth-child(8)  { height: 22px; animation-delay: 0.50s; }
    .waveform .bar:nth-child(9)  { height: 30px; animation-delay: 0.40s; }
    .waveform .bar:nth-child(10) { height: 14px; animation-delay: 0.30s; }
    .waveform .bar:nth-child(11) { height: 26px; animation-delay: 0.20s; }
    .waveform .bar:nth-child(12) { height: 10px; animation-delay: 0.10s; }
    .waveform .bar:nth-child(13) { height: 20px; animation-delay: 0.00s; }
    .waveform .bar:nth-child(14) { height: 8px;  animation-delay: 0.10s; }
    .waveform .bar:nth-child(15) { height: 14px; animation-delay: 0.20s; }
    .waveform .bar:nth-child(16) { height: 5px;  animation-delay: 0.30s; }
    .waveform .bar:nth-child(17) { height: 10px; animation-delay: 0.40s; }
    .waveform .bar:nth-child(18) { height: 4px;  animation-delay: 0.50s; }
    .waveform-label {
      margin-left: 10px; font-size: 10px; font-weight: 500;
      color: rgba(255,255,255,0.55); letter-spacing: 0.06em;
      text-transform: uppercase; white-space: nowrap;
    }
    @keyframes wave {
      0%, 100% { transform: scaleY(1);   opacity: 0.85; }
      50%       { transform: scaleY(0.35); opacity: 0.4;  }
    }

    /* ── Body ── */
    .body { padding: 36px 44px; background: #FFFFFF; }

    /* Doc card */
    .doc-card {
      background: linear-gradient(135deg, #F0FAFB, #E8F6F8);
      border: 1.5px solid rgba(46,159,175,0.18);
      border-radius: 16px; padding: 22px 24px;
      display: flex; align-items: center; justify-content: space-between; gap: 16px;
      margin-bottom: 28px;
      position: relative; overflow: hidden;
    }
    .doc-card::before {
      content: ''; position: absolute;
      left: 0; top: 0; bottom: 0; width: 4px;
      background: linear-gradient(180deg, #2E9FAF, #3BBDCC);
      border-radius: 4px 0 0 4px;
    }

    .doc-left { display: flex; align-items: center; gap: 14px; min-width: 0; flex: 1; }

    .doc-file-icon {
      flex-shrink: 0; width: 46px; height: 46px;
      background: linear-gradient(135deg, #2E9FAF, #3BBDCC);
      border-radius: 12px;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 4px 12px rgba(46,159,175,0.3);
    }
    .doc-file-icon svg { width: 22px; height: 22px; }

    .doc-info { min-width: 0; }
    .doc-filename {
      font-size: 13px; font-weight: 600; color: #1A4D55;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .doc-filetype {
      display: inline-flex; align-items: center; margin-top: 4px;
      background: rgba(46,159,175,0.12); border-radius: 4px; padding: 2px 8px;
    }
    .doc-filetype span { font-size: 10px; font-weight: 600; color: #2E9FAF; letter-spacing: 0.06em; text-transform: uppercase; }

    .open-btn {
      flex-shrink: 0;
      display: inline-flex; align-items: center; gap: 8px;
      background: linear-gradient(135deg, #2E9FAF, #3BBDCC);
      color: #FFFFFF; text-decoration: none;
      font-size: 13px; font-weight: 600;
      padding: 12px 22px; border-radius: 12px;
      box-shadow: 0 4px 16px rgba(46,159,175,0.35);
      transition: transform 0.15s ease, box-shadow 0.15s ease;
      letter-spacing: 0.01em;
      white-space: nowrap;
    }
    .open-btn:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(46,159,175,0.45); }
    .open-btn svg { width: 13px; height: 13px; }

    /* Journey strip */
    .how-it-worked {
      background: #F7FCFD;
      border: 1px solid rgba(46,159,175,0.1);
      border-radius: 14px; padding: 20px 22px; margin-bottom: 28px;
    }
    .how-title {
      font-size: 10px; font-weight: 600; color: #9EC8CE;
      letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 16px;
    }

    .steps { display: flex; align-items: center; }
    .step { display: flex; flex-direction: column; align-items: center; gap: 7px; flex: 1; text-align: center; }
    .step-icon {
      width: 34px; height: 34px; border-radius: 50%;
      background: rgba(46,159,175,0.1);
      border: 1.5px solid rgba(46,159,175,0.22);
      display: flex; align-items: center; justify-content: center;
    }
    .step-icon svg { width: 14px; height: 14px; }
    .step-label { font-size: 10px; font-weight: 400; color: #7BB5BD; line-height: 1.3; }
    .step-connector {
      flex: 0.4; height: 1.5px;
      background: linear-gradient(90deg, rgba(46,159,175,0.25), rgba(59,189,204,0.25));
      margin-bottom: 20px;
    }

    /* Footer */
    .footer { text-align: center; padding: 22px 0 0; }
    .footer p { font-size: 11px; font-weight: 300; color: #9EC8CE; letter-spacing: 0.03em; }

    /* ══════════════════════════════════ */
    /*  TABLET  ≤ 600px                  */
    /* ══════════════════════════════════ */
    @media (max-width: 600px) {
      body { padding: 24px 16px; align-items: flex-start; }

      /* Header */
      .header { margin-bottom: 16px; }
      .logo-text { font-size: 13px; }
      .logo-sub  { font-size: 9px; }
      .voice-badge { padding: 5px 10px; }
      .voice-badge span { font-size: 9px; }

      /* Hero */
      .hero { padding: 28px 24px 26px; }
      .hero-greeting { font-size: 22px; }
      .hero-sub { font-size: 13px; margin-bottom: 22px; }
      .hero-deco { display: none; }

      /* Body */
      .body { padding: 24px 20px; }

      /* Doc card — stack vertically */
      .doc-card {
        flex-direction: column;
        align-items: flex-start;
        gap: 16px;
        padding: 18px 18px 18px 22px;
      }
      .doc-left { width: 100%; }
      .doc-filename { white-space: normal; word-break: break-word; }
      .open-btn {
        width: 100%;
        justify-content: center;
        padding: 13px;
        border-radius: 10px;
      }

      /* Journey — stack vertically */
      .steps { flex-direction: column; align-items: stretch; gap: 0; }
      .step {
        flex-direction: row;
        text-align: left;
        gap: 14px;
        padding: 10px 0;
        border-bottom: 1px solid rgba(46,159,175,0.08);
      }
      .step:last-child { border-bottom: none; padding-bottom: 0; }
      .step-label { font-size: 11px; line-height: 1.4; }
      .step-connector { display: none; }

      /* Waveform — trim bars on small screens */
      .waveform .bar:nth-child(n+13) { display: none; }
      .waveform-label { font-size: 9px; }
    }

    /* ══════════════════════════════════ */
    /*  MOBILE  ≤ 400px                  */
    /* ══════════════════════════════════ */
    @media (max-width: 400px) {
      body { padding: 16px 12px; }

      /* Header — hide badge, keep logo */
      .voice-badge { display: none; }
      .logo-icon { width: 34px; height: 34px; border-radius: 10px; }
      .logo-icon svg { width: 18px; height: 18px; }
      .logo-text { font-size: 13px; }

      /* Hero */
      .hero { padding: 24px 18px 22px; }
      .hero-tag { margin-bottom: 14px; }
      .hero-greeting { font-size: 20px; }
      .hero-sub { font-size: 12px; }

      /* Waveform — hide on very tiny screens */
      .waveform { display: none; }

      /* Body */
      .body { padding: 20px 16px; }

      /* Doc card */
      .doc-card { padding: 16px 16px 16px 20px; }
      .doc-file-icon { width: 38px; height: 38px; border-radius: 10px; }
      .doc-file-icon svg { width: 18px; height: 18px; }
      .doc-filename { font-size: 12px; }

      /* Journey */
      .how-it-worked { padding: 16px; }
      .step { padding: 8px 0; }
      .step-icon { width: 28px; height: 28px; }
      .step-icon svg { width: 12px; height: 12px; }

      /* Footer */
      .footer p { font-size: 10px; }
    }
  </style>
</head>
<body>
  <div class="wrapper">

    <!-- Header -->
    <div class="header">
      <div class="logo">
        <div class="logo-icon">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <polygon points="12,4 22,9 12,14 2,9" fill="white"/>
            <path d="M6 11.5V17C6 17 8.5 20 12 20C15.5 20 18 17 18 17V11.5" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            <line x1="19.5" y1="10" x2="19.5" y2="17" stroke="white" stroke-width="1.6" stroke-linecap="round"/>
            <circle cx="19.5" cy="18" r="1.3" fill="white" opacity="0.85"/>
          </svg>
        </div>
        <div>
          <div class="logo-text">Smart School</div>
          <div class="logo-sub">Voice AI Platform</div>
        </div>
      </div>
      <div class="voice-badge">
        <div class="dot"></div>
        <span>Voice AI</span>
      </div>
    </div>

    <!-- Card -->
    <div class="card">

      <!-- Hero -->
      <div class="hero">
        <div class="hero-deco"></div>

        <div class="hero-tag">
          <svg viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="6" cy="6" r="4.5" stroke="white" stroke-width="1.2"/>
            <path d="M4.2 6L5.4 7.2L7.8 4.8" stroke="white" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span>Document Delivered</span>
        </div>

        <h1 class="hero-greeting">
          Hi <span class="name-highlight">${teacher_name}</span>,<br>your file is ready ✦
        </h1>
        <p class="hero-sub">
          Your voice request was heard and processed.<br>
          The document has been sent straight to your inbox.
        </p>

        <div class="waveform">
          <div class="bar"></div><div class="bar"></div><div class="bar"></div>
          <div class="bar"></div><div class="bar"></div><div class="bar"></div>
          <div class="bar"></div><div class="bar"></div><div class="bar"></div>
          <div class="bar"></div><div class="bar"></div><div class="bar"></div>
          <div class="bar"></div><div class="bar"></div><div class="bar"></div>
          <div class="bar"></div><div class="bar"></div><div class="bar"></div>
          <span class="waveform-label">Voice processed</span>
        </div>
      </div>

      <!-- Body -->
      <div class="body">

        <!-- Document card -->
        <div class="doc-card">
          <div class="doc-left">
            <div class="doc-file-icon">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M4 4C4 2.89543 4.89543 2 6 2H14L20 8V20C20 21.1046 19.1046 22 18 22H6C4.89543 22 4 21.1046 4 20V4Z" stroke="white" stroke-width="1.6"/>
                <path d="M14 2V8H20" stroke="white" stroke-width="1.6" stroke-linejoin="round"/>
                <path d="M8 13H16" stroke="white" stroke-width="1.4" stroke-linecap="round"/>
                <path d="M8 17H12" stroke="white" stroke-width="1.4" stroke-linecap="round"/>
              </svg>
            </div>
            <div class="doc-info">
              <div class="doc-filename">${found.pdf_name}</div>
              <div class="doc-filetype"><span>PDF Document</span></div>
            </div>
          </div>
          <a href="${found.pdf_link}" class="open-btn">
            Open
            <svg viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M1.5 11.5L11.5 1.5M11.5 1.5H5.5M11.5 1.5V7.5" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </a>
        </div>

        <!-- Journey -->
        <div class="how-it-worked">
          <div class="how-title">How this was delivered</div>
          <div class="steps">

            <div class="step">
              <div class="step-icon">
                <svg viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect x="4.5" y="1" width="5" height="7" rx="2.5" stroke="#2E9FAF" stroke-width="1.2"/>
                  <path d="M2 7C2 9.76142 4.23858 12 7 12M12 7C12 9.76142 9.76142 12 7 12M7 12V14" stroke="#2E9FAF" stroke-width="1.2" stroke-linecap="round"/>
                </svg>
              </div>
              <div class="step-label">Voice<br>request</div>
            </div>

            <div class="step-connector"></div>

            <div class="step">
              <div class="step-icon">
                <svg viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect x="3" y="3" width="8" height="8" rx="2" stroke="#2E9FAF" stroke-width="1.2"/>
                  <circle cx="7" cy="7" r="1.5" fill="#2E9FAF" opacity="0.5"/>
                  <path d="M3 5.5H1M3 8.5H1M11 5.5H13M11 8.5H13M5.5 3V1M8.5 3V1M5.5 11V13M8.5 11V13" stroke="#2E9FAF" stroke-width="1.1" stroke-linecap="round"/>
                </svg>
              </div>
              <div class="step-label">AI<br>processed</div>
            </div>

            <div class="step-connector"></div>

            <div class="step">
              <div class="step-icon">
                <svg viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M2.5 2C2.5 1.44772 2.94772 1 3.5 1H8.5L11.5 4V12C11.5 12.5523 11.0523 13 10.5 13H3.5C2.94772 13 2.5 12.5523 2.5 12V2Z" stroke="#2E9FAF" stroke-width="1.1"/>
                  <path d="M8.5 1V4H11.5" stroke="#2E9FAF" stroke-width="1.1"/>
                  <path d="M4.5 7.5L6 9L9.5 5.5" stroke="#2E9FAF" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </div>
              <div class="step-label">File<br>found</div>
            </div>

            <div class="step-connector"></div>

            <div class="step">
              <div class="step-icon">
                <svg viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect x="1" y="3" width="12" height="9" rx="1.5" stroke="#2E9FAF" stroke-width="1.1"/>
                  <path d="M1 4.5L7 8.5L13 4.5" stroke="#2E9FAF" stroke-width="1.1" stroke-linecap="round"/>
                </svg>
              </div>
              <div class="step-label">Email<br>sent</div>
            </div>

          </div>
        </div>

      </div>
    </div>

    <div class="footer">
      <p>Sent automatically via Smart School Voice AI &nbsp;·&nbsp; Do not reply to this email</p>
    </div>

  </div>
</body>
</html>
`;

    // Send email (Resend)
    const emailResult = await resend.emails.send({
      from: process.env.EMAIL_FROM,
      to: teacher_email,
      subject,
      html,
      text: `Hi ${teacher_name}, here is your document: ${found.pdf_link}`,
    });

    return res.json({
      ok: true,
      message: "PDF sent successfully",
      pdf_name: found.pdf_name,
      pdf_link: found.pdf_link,
      email_id: emailResult.id,
    });
  } catch (err) {
    console.error("❌ ERROR:", err);
    return res.status(500).json({
      ok: false,
      message: err.message || "Server error",
    });
  }
});

module.exports = router;
