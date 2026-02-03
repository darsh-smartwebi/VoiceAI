const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const fs = require("fs");
const { parse } = require("csv-parse/sync");
const { Resend } = require("resend");

dotenv.config();

const app = express();

// ==============================
// 0) Middleware (Smartwebi-proof)
// ==============================
app.use(cors());
app.use(
  express.json({
    limit: "1mb",
    type: ["application/json", "*/json", "*/*"],
  }),
);
app.use(express.urlencoded({ extended: true }));

// ==============================
// 1) Load CSV ONCE (fast)
// ==============================
let PDF_TABLE = [];

function loadPdfTableOnce() {
  const csv = fs.readFileSync("./grade1.csv", "utf8");
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
// 3) PDF NAME MATCHING (robust)
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

    // ===== Grade / Level =====
    "gk",
    "k",
    "k-2",
    "k-3",
    "k-5",
    "grade",

    // ===== Foundational Skills =====
    "foundational",
    "skills",
    "fs",
    "activity",
    "big",
    "reader",
    "digital",
    "visuals",
    "components",
    "support",

    // ===== Phonics / Code =====
    "consonant",
    "vowel",
    "code",
    "flip",
    "book",
    "chart",
    "individual",
    "spelling",
    "cards",
    "letter",
    "image",

    // ===== RLA =====
    "rla",

    // ===== Units =====
    "unit",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "10",

    // ===== FS Levels =====
    "fs1",
    "fs2",
    "fs3",
    "fs4",
    "fs5",
    "fs6",
    "fs7",

    // ===== Content Types =====
    "activity",
    "reader",
    "guide",
    "flip",
    "cards",
    "visuals",
    "book",
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
app.get("/reload", (req, res) => {
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
app.get("/mcp", (req, res) => {
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
app.post("/mcp/tools/send_pdf_by_name", async (req, res) => {
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
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 600px; width: 100%; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
          <tr>
            <td style="padding: 32px 40px 24px; border-bottom: 3px solid #2563eb;">
              <h1 style="margin: 0; color: #1f2937; font-size: 24px; font-weight: 600;">Hi ${teacher_name},</h1>
            </td>
          </tr>

          <tr>
            <td style="padding: 32px 40px;">
              <p style="margin: 0 0 24px; color: #4b5563; font-size: 16px; line-height: 1.6;">
                Here is your requested document:
              </p>

              <div style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 20px; margin-bottom: 24px;">
                <p style="margin: 0 0 12px; color: #1f2937; font-size: 16px; font-weight: 600;">
                  📄 ${found.pdf_name}
                </p>
                <a href="${found.pdf_link}" style="display: inline-block; color: #2563eb; text-decoration: none; font-size: 14px; font-weight: 500; padding: 10px 20px; background-color: #dbeafe; border-radius: 4px;">
                  Document Link →
                </a>
              </div>
            </td>
          </tr>

          <tr>
            <td style="padding: 24px 40px 32px; border-top: 1px solid #e5e7eb;">
              <p style="margin: 0; color: #6b7280; font-size: 14px; font-weight: 500;">
                — Smart School
              </p>
            </td>
          </tr>
        </table>

        <p style="margin: 20px 0 0; color: #9ca3af; font-size: 12px; text-align: center;">
          This is an automated message from Smart School
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

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

// ==============================
app.listen(process.env.PORT || 5050, () => {
  console.log(`🚀 MCP server running on port ${process.env.PORT || 5050}`);
});
