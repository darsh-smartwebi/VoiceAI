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
function findPdfByName(pdfName) {
  const search = (pdfName || "").trim().toLowerCase();
  if (!search) return null;

  // 1) Exact match
  let found =
    PDF_TABLE.find((x) => (x.pdf_name || "").trim().toLowerCase() === search) ||
    null;

  // 2) Partial match (fallback)
  if (!found) {
    found =
      PDF_TABLE.find((x) =>
        (x.pdf_name || "").trim().toLowerCase().includes(search),
      ) || null;
  }

  return found;
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
      data.pdf_name ||
      data.pdfName ||
      data.requested_pdf ||
      body.customData?.pdf_name ||
      body.customData?.pdfName ||
      body.customData?.requested_pdf ||
      body.triggerData?.pdf_name ||
      body.triggerData?.requested_pdf;

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
    const subject = `Requested PDF: ${found.pdf_name}`;
    const text =
      `Hi ${teacher_name},\n\n` +
      `Here is your requested document:\n\n` +
      `${found.pdf_name}\n${found.pdf_link}\n\n` +
      `— ESC 17`;

    // Send email (Resend)
    const emailResult = await resend.emails.send({
      from: process.env.EMAIL_FROM,
      to: teacher_email,
      subject,
      text,
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
