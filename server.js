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
    keyword: (r.keyword || "").trim().toLowerCase(),
    pdf_name: (r.pdf_name || "").trim(),
    pdf_link: (r.pdf_link || "").trim(),
  }));

  console.log(`✅ Loaded ${PDF_TABLE.length} PDFs from grade1.csv`);
}

function findPdfByKeyword(keyword) {
  const key = (keyword || "").trim().toLowerCase();
  return PDF_TABLE.find((x) => x.keyword === key) || null;
}

loadPdfTableOnce();

// Optional reload endpoint
app.get("/reload", (req, res) => {
  try {
    loadPdfTableOnce();
    res.json({ ok: true, count: PDF_TABLE.length });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ==============================
// 2) Resend Email Client
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
        name: "send_pdf_by_keyword",
        description: "Find PDF by keyword and email it to the teacher.",
        inputSchema: {
          type: "object",
          properties: {
            keyword: { type: "string" },
            teacher_name: { type: "string" },
            teacher_email: { type: "string" },
          },
          required: ["keyword", "teacher_name", "teacher_email"],
        },
      },
    ],
  });
});

// ==============================
// 4) MCP tool endpoint
// ==============================
app.post("/mcp/tools/send_pdf_by_keyword", async (req, res) => {
  try {
    console.log("----- INCOMING REQUEST -----");
    console.log("HEADERS:", req.headers);
    console.log("BODY:", JSON.stringify(req.body, null, 2));

    const data =
      req.body?.input ||
      req.body?.arguments ||
      req.body?.payload ||
      req.body ||
      {};

    const keyword = data.keyword || data.requested_pdf;
    const teacher_name = data.teacher_name || data.name;
    const teacher_email = data.teacher_email || data.email;

    if (!keyword || !teacher_name || !teacher_email) {
      return res.status(400).json({
        ok: false,
        message:
          "Missing required fields: keyword, teacher_name, teacher_email",
        received_keys: Object.keys(data),
      });
    }

    const found = findPdfByKeyword(keyword);
    if (!found) {
      return res.status(404).json({
        ok: false,
        message: "No PDF found for that keyword",
        keyword,
      });
    }

    const subject = `Requested PDF: ${found.pdf_name}`;
    const text =
      `Hi ${teacher_name},\n\n` +
      `Here is your requested document:\n\n` +
      `${found.pdf_name}\n${found.pdf_link}\n\n` +
      `— ESC 17`;

    // ✅ Send email via Resend
    const emailResponse = await resend.emails.send({
      from: process.env.EMAIL_FROM,
      to: teacher_email,
      subject,
      text,
    });

    return res.json({
      ok: true,
      message: "PDF sent successfully",
      keyword,
      pdf_name: found.pdf_name,
      email_id: emailResponse.id,
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
